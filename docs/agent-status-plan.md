# Agent Status Plan

## Goal

Show useful per-agent status inside one Orca worktree:

- current short description of what the agent is doing
- current short description of what it plans to do next
- a clear finished state when the agent is done

This should work across all agent types Orca supports, not just one integration.

## Current State

Orca already has two relevant primitives:

1. Terminal-title heuristics can infer coarse state like `working`, `permission`, and `idle` for Claude, Codex, Gemini, OpenCode, and Aider.
2. Worktrees already have a persisted `comment` field for user-authored notes.

That means we do **not** need to invent status from nothing. The gap is that Orca currently has:

- a coarse machine-inferred state
- a user note field that is not safe to repurpose as structured agent status
- no structured "next step"
- no explicit "done" status for agent progress

## Recommendation

Use a **hybrid design**:

1. Add a small **explicit agent-status reporting mechanism** in Orca.
2. Ask agents to report at meaningful checkpoints via a **small injected prompt snippet** in Orca.
3. Keep the existing title heuristics as a **fallback path** for agents that do not cooperate or cannot be modified.
4. Add a **worktree status hover** on the existing status icon so users can inspect all currently running agents in that worktree without opening terminals.

This is the best tradeoff because:

- explicit updates are the only reliable way to get "what I am doing" and "what I plan to do next"
- title parsing alone can only tell us coarse activity, not intent
- keeping fallback heuristics means all agent types still show *something* even before they adopt the new protocol
- leaving `comment` user-owned avoids mixing a personal note field with machine-managed agent state

**Decision:** Use **`orca status set` CLI commands via IPC** as the primary transport for agent-reported status. The CLI sends status to the running Orca app over the existing Unix socket RPC (`RuntimeClient`), which forwards it to the renderer's zustand store. Status is real-time only — it lives in renderer memory and is not persisted to disk. See the [Transport Mechanism](#transport-mechanism) section below for the rationale.

## Why Not Just Reuse `comment`

Using only `worktree.comment` is the fastest possible version, but it is too narrow for the full goal.

Problems with a comment-only approach:

- no schema for `doing` vs `next`
- no explicit `done` / `blocked` / `waiting for input` state
- easy for different agent types to format inconsistently
- difficult to evolve without brittle string parsing later
- it overwrites or conflicts with existing user-authored notes on the worktree card

`comment` should remain a user field. Agent status should be stored and rendered separately.

## Proposed Data Model

Status is **real-time only** — it shows what agents are doing right now and lives entirely in renderer memory (a zustand store slice). When the app restarts, a terminal exits, or the renderer reloads, status is gone. There is no persistence to disk, no bounded history log, no staleness TTL for persistence purposes, and no cleanup-on-worktree-remove logic for status stores.

Why no persistence: agent status is inherently ephemeral. If an agent is not running, its status is meaningless. The value is in glancing at what is happening *now*, not in replaying what happened yesterday. Persistence would add write overhead, cleanup complexity (orphaned entries after worktree removal, renderer reloads, archive), and a staleness problem — all for data that is useful only while the agent is live. The existing terminal presence heuristics already tell us whether something is running; explicit status just enriches that with *what* it is doing.

Entries are keyed by a composite `${tabId}:${paneId}` string (called `paneKey`) in the renderer. A single tab can contain multiple split panes, each running an independent agent, so `tabId` alone is not granular enough. This follows the existing `cacheTimerByKey` pattern in `pty-connection.ts`, which uses the same `${tabId}:${paneId}` composite key to track per-pane prompt-cache timers. No `terminalHandle` or UUID mapping is needed — the renderer knows which tab and pane produced each PTY data event.

```ts
type AgentStatusState = 'working' | 'blocked' | 'waiting' | 'done'

type AgentStatusEntry = {
  state: AgentStatusState
  summary: string
  next: string
  updatedAt: number
  source: 'agent' | 'heuristic'
  agentType?: 'claude' | 'codex' | 'gemini' | 'opencode' | 'aider' | 'unknown'
  paneKey: string // `${tabId}:${paneId}` composite — matches cacheTimerByKey convention
  terminalTitle?: string
}
```

The zustand slice is a simple map from `paneKey` to `AgentStatusEntry`:

```ts
type AgentStatusSlice = {
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
}
```

When a pane's terminal exits, its entry is removed from the map. When a tab is closed, all entries whose `paneKey` starts with `${tabId}:` are removed — the same prefix-sweep pattern that `closeTab` already uses for `cacheTimerByKey`. When the renderer reloads, the map starts empty — there are no orphaned entries to sweep because there is no persistent store.

Why this shape:

- the user asked for status of the agents running in one worktree
- the hover should show **everything currently running in the worktree**, not just one primary status
- `WorktreeMeta` is currently a user-authored metadata surface, so agent status should not piggyback on it
- `${tabId}:${paneId}` is the natural renderer-side attribution key for "who is currently reporting" — it matches the existing `cacheTimerByKey` convention and requires no mapping or lifecycle management beyond what the tab/pane system already provides
- grouping by worktree for the hover is a view concern: the renderer already knows which tabs belong to which worktree, so it can filter `agentStatusByPaneKey` at render time

### State Mapping

The codebase has three related but distinct type systems for agent state:

- `AgentStatusState = 'working' | 'blocked' | 'waiting' | 'done'` — the explicit states an agent reports via OSC (defined in this design)
- `AgentStatus = 'working' | 'permission' | 'idle'` — the heuristic states inferred from terminal titles (`agent-status.ts`)
- `Status = 'active' | 'working' | 'permission' | 'inactive'` — the visual rendering states used by `StatusIndicator`

When explicit status is present, it takes precedence over heuristic detection (explicit > heuristic, as described in the UI Plan). The mapping from explicit `AgentStatusState` to visual `StatusIndicator.Status` is:

| Explicit `AgentStatusState` | Visual `Status` | Rendering |
|---|---|---|
| `working` | `working` | Green spinner — agent is actively executing |
| `blocked` | `permission` | Red dot — agent needs user attention |
| `waiting` | `permission` | Red dot — agent needs user attention |
| `done` | `active` | Green dot, no spinner — task completed successfully |
| *(no explicit status)* | *(fall through to heuristic)* | Existing `detectAgentStatusFromTitle` logic applies as today |

Why `blocked` and `waiting` both map to `permission`: from the user's perspective, both mean "this agent cannot make progress without me." The distinction between blocked (e.g., test failures) and waiting (e.g., awaiting approval) is useful in the hover summary text, but the visual indicator should communicate the same urgency. Why `done` maps to `active` rather than `inactive`: a completed agent still has a live terminal — `inactive` (gray dot) would incorrectly suggest nothing is there.

**Conflict resolution:** If an agent reports explicit status but the heuristic disagrees (e.g., the agent reports `working` but the title shows a permission prompt), the explicit status wins. The heuristic is a best-effort inference from title patterns and can lag behind or misinterpret; the agent's own reporting is authoritative.

**Smart-sort scoring:** Explicit status should feed into `computeSmartScoreFromSignals` with the same weights as their heuristic equivalents:

- Explicit `working` → +60 (same as heuristic `working`)
- Explicit `blocked` or `waiting` → +35 (same as heuristic `permission`)
- Explicit `done` → no bonus (task is complete, no attention needed)

This means a worktree with an explicitly blocked agent sorts the same as one where the heuristic detects a permission prompt — the user sees attention-needed worktrees near the top regardless of how the status was determined.

## Payload Constraints (Keep Hover Readable)

Agent-provided status is untrusted input from Orca's perspective. To keep the hover UI readable, Orca should normalize the payload before storing it in the zustand slice:

- `summary` and `next` are treated as single-line strings: trim and replace newlines with spaces.
- enforce a max length (for example `200` characters each) and truncate beyond that limit.

Truncation is preferred over rejecting the payload, because the goal of status reporting is to degrade gracefully rather than block agents on formatting.

### Reporter Attribution (Pane Identity)

The design relies on per-pane attribution so the hover can show multiple concurrently running agents in one worktree — including split panes within the same tab. Attribution is solved by environment variable injection: Orca injects `ORCA_PANE_KEY=${tabId}:${paneId}` into every spawned terminal's environment via `pty:spawn`. The CLI reads this env var and includes it in the RPC payload, so the renderer knows exactly which pane reported the status.

Because status lives only in renderer memory keyed by `paneKey`, there is no orphan cleanup problem. When a pane's terminal exits, its entry is removed; when a tab closes, all its pane entries are swept by prefix (same pattern as `cacheTimerByKey` cleanup in `closeTab`). When the renderer reloads, the zustand store starts fresh — no stale entries, no sweep logic, no lifecycle reconciliation. This is a direct consequence of choosing renderer-only state over persistence.

### CLI Surface

The CLI is the primary write path for agent-reported status. Agents call `orca status set` to report what they are doing:

```
orca status set --state working --summary "Investigating auth test failures" --next "Fix the flaky assertion in login.test.ts"
```

The CLI sends the status payload to the running Orca app over the existing Unix socket RPC (`RuntimeClient` in `src/cli/runtime-client.ts`). The runtime forwards it to the renderer via IPC, which stores it in the zustand slice.

**Pane attribution** is solved by environment variable injection: Orca injects `ORCA_PANE_KEY` (the `${tabId}:${paneId}` composite) into every spawned terminal's environment via `pty:spawn`. The CLI reads `ORCA_PANE_KEY` from its environment and includes it in the RPC payload. No worktree resolution is needed — the renderer already knows which worktree owns which pane.

Why `ORCA_PANE_KEY` is stable: tab and pane IDs are assigned at terminal creation and persisted in worktree config. They do not change on renderer reload. A renderer reload resets the zustand store (which is correct — ephemeral status starts fresh), but the env var in the surviving shell process remains valid for new status reports because the pane key is reassigned from the same persisted config.

**No CLI read path**: with renderer-only state, there is nothing meaningful for the CLI to read. Status lives in the zustand store, not in a persisted file. The hover UI is the read surface.

**Debuggability**: for development testing, `orca status set` is itself the debug tool — run it from any Orca terminal and check the hover UI. No special debug surface needed.

## Transport Mechanism

The transport question is settled: **`orca status set` CLI commands via IPC** are the write path for agent-reported status. This section documents the rationale and the alternatives that were considered.

### CLI via IPC (Chosen)

Agents call a CLI command to report status:

```
orca status set --state working --summary "Investigating auth test failures" --next "Fix the flaky assertion in login.test.ts"
```

The CLI sends the payload to the running Orca app via the existing Unix socket RPC (`RuntimeClient` in `src/cli/runtime-client.ts`).

How it works:

- Agent runs `orca status set` with structured flags
- The CLI reads `ORCA_PANE_KEY` from the environment (injected by Orca when spawning the terminal)
- The CLI calls `RuntimeClient.call('agentStatus.set', { paneKey, state, summary, next })` over the existing Unix socket
- The runtime handler in the main process forwards the payload to the renderer via IPC (`mainWindow.webContents.send`)
- The renderer receives the IPC event and writes to the `agentStatusByPaneKey` zustand slice
- The hover UI reads from the slice — same as before

Why this works well:

- **self-documenting tool calls** — when the user watches an agent, they see `orca status set --state working --summary "Fix auth"` instead of a cryptic `printf` with escape codes. The visible Bash tool call is clear and understandable.
- **existing IPC infrastructure** — `RuntimeClient` already handles CLI → app communication over Unix sockets with auth tokens, timeouts, and error handling. Adding a new RPC method is a few lines of code.
- **pane attribution via env var** — Orca already passes custom `env` to `pty:spawn`. Injecting `ORCA_PANE_KEY=${tabId}:${paneId}` uses the existing plumbing. The pane key is stable (persisted in worktree config), so surviving terminals retain valid keys across renderer reloads.
- **no worktree resolution** — the CLI sends the pane key, not a cwd. The renderer already knows which worktree owns which pane. No expensive `resolveCurrentWorktreeSelector` enumeration.
- **input validation** — the CLI can validate state values, enforce field length limits, and return clear error messages before sending to the app
- **natural agent instruction** — "run `orca status set`" is a familiar CLI pattern that agents handle well, less error-prone than getting printf escape syntax exactly right
- **extensible** — adding new flags (e.g., `--progress 75%`) is a CLI change, not a binary protocol change

Tradeoffs accepted:

- **subprocess spawn overhead** — one `orca` process per status report (~5ms). At the 5-15 minute reporting cadence this is negligible.
- **env var injection required** — Orca must inject `ORCA_PANE_KEY` into every spawned terminal. This is a small change to `pty:spawn` since the `env` parameter already exists.
- **requires Orca CLI installed** — the `orca` command must be on PATH. This is already a setting in Orca's preferences (`CliSection.tsx`) and is the expected setup for CLI features.
- **IPC dependency** — the status report fails if the Orca app is not running or the socket is unavailable. This is acceptable because agent status is only meaningful while Orca is running. The CLI should fail silently (exit 0) so it never interrupts the agent's work.

### Why Not OSC Escape Sequences (Considered and Rejected)

An earlier version of this design used OSC escape sequences as the sole transport:

```
printf '\x1b]9999;{"state":"working","summary":"...","next":"..."}\x07'
```

The agent would print a custom OSC sequence to stdout, and Orca's PTY parser (`pty-transport.ts`) would extract the JSON payload from the terminal data stream.

OSC had genuine advantages for transport:

- **free pane attribution** — the PTY stream inherently identifies which tab/pane produced the data, so no env var injection was needed
- **zero process overhead** — no subprocess spawn, no socket connection
- **standard practice** — VS Code, iTerm2, and kitty all use custom OSC sequences for similar purposes

However, OSC was rejected because of a UX problem that only became apparent during implementation:

- **cryptic visible tool calls** — agents use Bash tool calls to emit the printf. The user sees `Bash(printf '\x1b]9999;{"state":"working",...}\x07')` in their terminal, which is incomprehensible. Since rich status summaries require the agent to make a tool call (hooks cannot provide summaries), the tool call is unavoidable — and `orca status set --summary "Fix auth"` is vastly more readable than raw escape codes.
- **fragile prompt contract** — agents must get the printf escape syntax exactly right (`\x1b`, `\x07`, proper JSON escaping). CLI flags are harder to get wrong.
- **if you're spawning a process anyway, use IPC** — the moment the agent runs a Bash command, the subprocess overhead argument for OSC disappears. And if you're running a subprocess, having it talk directly to the app via IPC is simpler than routing through the PTY byte stream.

The pane attribution problem that originally motivated OSC over CLI turned out to be straightforward to solve: inject `ORCA_PANE_KEY` via the existing `env` parameter in `pty:spawn`.

### Prior Art: Superset (superset-sh/superset)

Superset is a similar product — a desktop Electron app that orchestrates CLI-based coding agents across isolated git worktrees. Their approach to agent status uses **agent-native hooks + HTTP callbacks**, not CLI commands or OSC escape sequences.

#### Why they chose hooks + HTTP

Each major agent already has a native hook/plugin system (Claude Code hooks in `~/.claude/settings.json`, Codex hooks in `~/.codex/hooks.json`, OpenCode plugins, Cursor/Gemini/Copilot hooks, etc.). Rather than inventing a new reporting mechanism and asking agents to call it via prompt injection, Superset piggybacks on these existing hook systems. This means agents report lifecycle events automatically without any prompt overhead — the hooks fire on native agent events like prompt submission, tool use, and task completion.

The tradeoff is per-agent integration work. Superset maintains dedicated setup files for each agent type (`agent-wrappers-claude-codex-opencode.ts`, `agent-wrappers-gemini.ts`, `agent-wrappers-cursor.ts`, `agent-wrappers-copilot.ts`, `agent-wrappers-droid.ts`, `agent-wrappers-mastra.ts`, `agent-wrappers-amp.ts`). Each one knows how to install hooks into that agent's specific config format. When a new agent type appears, Superset must write a new integration.

#### How the full pipeline works

**1. Startup (agent setup):**

On app startup, `setupDesktopAgentCapabilities()` runs a sequence of setup actions:

- Creates a shared `notify.sh` shell script in `~/.superset/hooks/`
- Creates binary wrapper scripts in `~/.superset/bin/` that shadow real agent binaries (e.g., `claude`, `codex`). These wrappers find the real binary on `PATH` (skipping Superset's own bin dir), inject Superset env vars, and `exec` the real binary.
- Writes hook configs into each agent's global settings:
  - Claude: merges `UserPromptSubmit`, `Stop`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest` hooks into `~/.claude/settings.json`
  - Codex: merges `SessionStart`, `UserPromptSubmit`, `Stop` hooks into `~/.codex/hooks.json`, plus starts a background `tail -F` watcher on Codex's TUI session log for events Codex's hook system doesn't natively support (like `exec_approval_request`)
  - OpenCode: installs a plugin file in `~/.superset/opencode/plugin/`
  - Others: similar per-agent integrations

**2. Terminal env injection:**

Every terminal gets Superset-specific env vars via `buildTerminalEnv()`:

```
SUPERSET_PANE_ID=<paneId>
SUPERSET_TAB_ID=<tabId>
SUPERSET_WORKSPACE_ID=<workspaceId>
SUPERSET_PORT=<notification server port>
SUPERSET_ENV=development|production
SUPERSET_HOOK_VERSION=2
```

**3. Hook fires → notify.sh → HTTP callback:**

When a lifecycle event occurs (e.g., agent finishes a turn), the agent's native hook calls `notify.sh`. The script:

- Reads the hook JSON payload (from stdin for Claude, from `$1` for Codex)
- Extracts the event type, mapping agent-specific names to normalized values (e.g., Codex's `agent-turn-complete` → `Stop`, `exec_approval_request` → `PermissionRequest`)
- Reads the `SUPERSET_*` env vars for attribution
- Makes a `curl` GET request: `http://127.0.0.1:$PORT/hook/complete?paneId=...&tabId=...&eventType=Stop`
- Uses `--connect-timeout 1 --max-time 2` so it never blocks the agent

**4. HTTP server → event bus → renderer:**

The Express server at `/hook/complete`:

- Validates the environment (rejects dev/prod cross-talk)
- Normalizes the event type via `mapEventType()` to one of three values: `Start`, `Stop`, `PermissionRequest`
- Resolves the pane ID from the query parameters
- Emits an `AgentLifecycleEvent` on a shared `EventEmitter`
- The renderer subscribes via a tRPC subscription (`notifications.subscribe`) and updates the UI

#### What they capture

Only three lifecycle states: `Start`, `Stop`, `PermissionRequest`. The `AgentLifecycleEvent` type is:

```ts
interface AgentLifecycleEvent {
  paneId?: string
  tabId?: string
  workspaceId?: string
  eventType: 'Start' | 'Stop' | 'PermissionRequest'
}
```

There is no `summary`, no `next`, no structured status, no history. They know *whether* an agent is running and *when* it needs input, but not *what* it is doing.

#### Their OSC usage (shell readiness, not agent status)

Superset uses a custom OSC escape sequence — **OSC 777** (`\x1b]777;superset-shell-ready\x07`) — but only for **shell readiness signaling**: detecting when the shell prompt is ready after initialization, so they can buffer user input during shell startup. They chose OSC 777 to avoid conflicts with VS Code (OSC 133), iTerm2 (OSC 1337), and Warp (OSC 9001). Their headless terminal emulator already parses OSC-7 (cwd tracking) and DECSET/DECRST mode changes from the PTY byte stream.

#### Why our design differs

Superset's approach is essentially this design doc's Alternative #2 (Claude Code hooks) generalized across all agent types. It works well for coarse lifecycle state but cannot deliver what our design targets: structured summaries of *what the agent is doing* and *what it plans to do next*. That requires the agent itself to articulate intent, which hooks alone cannot provide — hooks fire on mechanical events (prompt submitted, tool used, task complete), not on semantic checkpoints (switched from investigation to implementation, became blocked on test failures).

Our design needs prompt injection or an equivalent mechanism to ask agents to describe their work at meaningful checkpoints. The hook approach and our approach are complementary — Orca could use hooks for reliable lifecycle events (start/stop/permission) while using prompt injection for richer status reporting.

If we choose the OSC approach for status transport, we should pick a code that avoids known-used codes: 7 (cwd), 133 (VS Code), 777 (Superset), 1337 (iTerm2), 9001 (Warp).

### Decision

Use **`orca status set` CLI commands via IPC** as the write path for agent-reported status. No CLI read path.

Why:

- the visible tool call is self-documenting (`orca status set --summary "Fix auth"` vs. cryptic printf escape codes)
- existing `RuntimeClient` IPC infrastructure handles the CLI → app communication with zero new transport code
- pane attribution is solved cleanly by injecting `ORCA_PANE_KEY` via the existing `env` parameter in `pty:spawn`
- the renderer already knows which worktree owns which pane, so no worktree resolution is needed
- CLI flags are less error-prone for agents than escape sequence syntax
- with renderer-only state, there is nothing for a CLI read path to return

The rest of this document therefore assumes:

- status writes arrive via `orca status set` → Unix socket RPC → IPC → renderer zustand slice
- the hover UI is the read surface for status
- heuristics remain the fallback when an agent does not emit explicit status

## Prompt / Skill Strategy

I would **not** make this a skill-only feature.

Skills are useful for some agents, but they are not the universal contract across all agent types. The stable contract should be:

- Orca runtime data model
- a reporting mechanism (`orca status set` CLI — see [Transport Mechanism](#transport-mechanism))
- tiny instruction injected by Orca when launching an agent

Recommended injected instruction:

> When you reach a meaningful checkpoint, update Orca with a short status: `orca status set --state working --summary "..." --next "..."`. Use state "done" when finished. Do not update on every trivial command.

Good checkpoints:

- switching from investigation to implementation
- proving or disproving a hypothesis
- finishing a meaningful code slice
- becoming blocked on permissions, tests, or user input
- finishing the task

When multiple agents are active in the same worktree, each agent should report independently. Orca owns the aggregation and ordering in the hover UI; agents should not try to coordinate with each other through the status API.

Why injection is better than a skill-only approach:

- works for more agent types
- keeps the instruction close to launch time
- avoids requiring every external tool to install Orca-specific skills
- gives Orca one consistent behavior contract

## Token / Overhead Analysis

This should be acceptable overhead if kept small.

Prompt overhead:

- one short injected instruction per agent launch
- likely tens of tokens, not hundreds

Behavior overhead:

- a few printf statements per task, only at meaningful checkpoints
- no model-token cost for the printf itself
- small reasoning overhead from the agent remembering to report status

I would explicitly avoid requiring updates on every step. The right cadence is probably:

- every 5 to 15 minutes of real work
- on phase changes
- on blocked state
- on done

That keeps the signal high and the burden low.

## Draft Skill: `orca-status`

Below is a draft of the injected instruction that Orca appends to the agent's system prompt when launching a terminal. This is the full text the agent sees — it should be self-contained and require no prior knowledge of Orca internals.

```
# Orca Status Reporting

You are running inside Orca, a terminal workspace manager. Orca can display
what you are working on in its sidebar if you report status at meaningful
checkpoints.

## How to report

Run the Orca CLI to update your status:

    orca status set --state working --summary "..." --next "..."

Flags:
- --state (required): one of "working", "blocked", "waiting", "done"
- --summary (optional): ≤200 chars, what you are doing right now
- --next (optional): ≤200 chars, what you plan to do next

Each report replaces the previous one. Omitted flags default to empty.

## When to report

Report at meaningful checkpoints — transitions in what you are doing, not
every small step.

Good checkpoints:
- starting a task ("working", summary of approach)
- switching from investigation to implementation
- becoming blocked on tests, permissions, or user input ("blocked" or "waiting")
- finishing a meaningful code change
- finishing the task ("done", summary of what was accomplished)

Do NOT report on:
- every shell command or file read
- every small edit
- intermediate reasoning steps

A good cadence is roughly every 5–15 minutes of real work, or whenever your
high-level activity changes.

## States

- "working": you are actively executing — investigating, coding, running tests
- "blocked": you cannot proceed without something being fixed (e.g., failing tests, missing dependency)
- "waiting": you need user input or approval before continuing
- "done": the task is complete

## Best-effort

Status reporting is fire-and-forget. If the command fails or the terminal is
not managed by Orca, nothing bad happens — the command exits silently.
Never retry a status update or let a failure interrupt your work.

## Examples

    orca status set --state working --summary "Investigating auth test failures" --next "Fix the flaky assertion in login.test.ts"

    orca status set --state blocked --summary "3 tests failing after refactor" --next "Need to update mock fixtures"

    orca status set --state done --summary "Refactored auth module, all tests passing"
```

### Design notes on the skill text

**Why this length.** The full instruction is ~250 tokens. This is small relative to a typical agent system prompt (thousands of tokens) and comparable to other injected instructions Orca already provides (CLI skill, repo context). The cost is paid once per agent launch, not per turn.

**Why examples matter.** Agents follow formatting conventions from examples more reliably than from abstract rules. The three examples cover the common status transitions (working → blocked → done) and demonstrate the right level of summary detail.

**Why "do NOT report on" is explicit.** Without negative guidance, agents tend to report on every action. The explicit "bad checkpoints" list prevents the status hover from becoming a noisy activity log.

**Why no mention of Orca internals.** The agent does not need to know about pane keys, zustand slices, IPC plumbing, or freshness thresholds. The instruction is a pure output contract: run this CLI command at these times.

**Why CLI instead of printf/OSC.** The agent's tool call is visible to the user. `orca status set --summary "Fix auth"` is self-documenting; `printf '\x1b]9999;...\x07'` is incomprehensible. Since rich summaries require a tool call regardless, the CLI is strictly better UX.

## UI Plan

In the worktree card / detail view, keep the existing presence icon behavior, but make the icon the entry point to richer status:

- coarse presence state from existing heuristics: `working`, `permission`, `idle`
- on hover over the worktree status icon, show:
  - all currently running agents in that worktree
  - per agent: `agentType`, current `summary`, `next`, and last update timestamp
  - a freshness indicator when an explicit entry has not been updated recently (see below)
- in the card body, keep status lightweight rather than duplicating the full hover content

Important precedence rule:

1. explicit agent status, if recent
2. heuristic terminal-title state, if explicit status is absent or stale
3. no fallback to `comment` for agent status; `comment` remains a separate user note

This matters because title heuristics can say "working" while the explicit status tells the user *what* is being worked on.

Interaction details:

- If multiple agents are active, the hover should list each one instead of collapsing to a single "primary" summary.
- If no explicit active statuses exist but heuristics show live terminals, the hover should list each detected agent terminal and say it has no reported task details yet.
- If nothing is running, the hover can show a simple empty state.

### Joining Explicit Status With Live Terminals

To satisfy "hover shows everything running in the worktree", the hover should be driven by a merge of:

1. Live tabs in the worktree (renderer truth) for "what is currently running"
2. Explicit per-pane status entries from `agentStatusByPaneKey` for "what it is doing / next"

Implementation note: both data sources live in the renderer — the tab/terminal state that drives the worktree presence icon today, and the new zustand status slice. No IPC roundtrip or runtime fetch is needed. The hover is a pure renderer-side computation.

If a tab is live but has no explicit entry, it still appears in the hover with heuristic-only details (agent type guess from title + coarse state). In this case, the hover should display something like "No task details reported" alongside the heuristic state, so the user understands that explicit status reporting exists as a capability but this particular agent has not called into it.

When a pane's terminal exits, its entry is removed from `agentStatusByPaneKey`. When a tab closes, all its pane entries are swept by `${tabId}:` prefix. There is no history to move entries to — they are simply gone. This is acceptable because the user can see the terminal is gone from the tab bar, and the hover only shows what is running *now*.

If a tab is still live but its explicit entry has not been updated recently, keep the tab in the active list based on heuristic presence, but visually downgrade the explicit summary with a freshness indicator rather than presenting it as authoritative current status. The strongest freshness signal is whether the terminal is still running — if the terminal is live, explicit status should not be hidden purely by elapsed time, because the agent may simply be in a long uninterrupted work phase. A visual indicator (e.g., "last updated 45m ago") is more useful than a hard TTL cutoff.

#### Ordering (Stable and Scan-Friendly)

The hover should have a stable sort order so it does not flicker while terminals update:

1. Attention-needed first (explicit `blocked` / `waiting`, or heuristic `permission`)
2. Then `working`
3. Then other live terminals

Within a group, sort by most recent `updatedAt` (explicit) or title-change timestamp (heuristic), descending.

## Rollout Plan

### Phase 1: CLI + IPC + Renderer State

- add `ORCA_PANE_KEY` env var injection in `pty:spawn` (`src/main/ipc/pty.ts`) — set `ORCA_PANE_KEY=${tabId}:${paneId}` in the env passed to node-pty
- add `orca status set` CLI subcommand that reads `ORCA_PANE_KEY` from env and calls `RuntimeClient.call('agentStatus.set', { paneKey, state, summary, next })`
- add `agentStatus.set` RPC handler in the runtime (`src/main/runtime/orca-runtime.ts`) that forwards the payload to the renderer via `mainWindow.webContents.send`
- add renderer-side IPC listener that writes to the `agentStatusByPaneKey` zustand slice
- add a zustand slice (`agentStatusByPaneKey`) for status entries (if not already present from OSC work)
- define payload normalization (single-line, max length, truncation)
- ensure status updates do **not** bump `lastActivityAt` or reorder worktrees on every checkpoint
- clean up entries when panes exit or tabs close (prefix-sweep on `${tabId}:`, matching `cacheTimerByKey` cleanup)
- CLI should exit 0 on failure (silent fail) so it never interrupts agent work

Success criteria:

- an agent can report status via `orca status set --state working --summary "..." --next "..."`
- the renderer receives the payload via IPC and stores it in the zustand slice keyed by `paneKey`
- status writes do not clobber user comments or create sort churn
- `orca status set` works from any Orca-managed terminal and fails silently outside Orca

### Phase 2: UI

- render a hover on the worktree status icon that shows all currently running agents in the worktree
- show done state clearly
- preserve existing heuristic active/permission badges
- show freshness indicators for entries that have not been updated recently

Success criteria:

- a user can tell at a glance whether a worktree is active from the icon
- hovering the icon reveals exactly what each running agent is doing and what it plans next

### Phase 3: Agent Adoption

Orca spawns shells, not agents — it has no generic mechanism to inject instructions into an arbitrary agent's system prompt at launch time. Each agent has its own extension system (Claude Code skills, Codex hooks, Gemini plugins, etc.), and there is no universal cross-agent injection API.

The adoption path is therefore per-agent, using each agent's native skill/plugin system:

- publish the `orca-status` skill so agents that support skills (e.g., Claude Code) can install it via `npx skills add`
- for other agents, document the `orca status set` CLI contract so users can add equivalent instructions to their AGENTS.md, codex.md, etc.
- expose the skill install command in Orca's settings UI so users can copy and run it

Success criteria:

- Claude Code users can install the `orca-status` skill and see status in the hover
- the `orca status set` CLI contract is documented so any agent can adopt it
- unsupported/manual terminals still degrade gracefully via heuristics

## Alternatives

### 1. OSC escape sequences

Example:

- agent prints `printf '\x1b]9999;{"state":"working","summary":"..."}\x07'` and Orca's PTY parser extracts the payload

Pros:

- free pane attribution from the PTY stream — no env var injection needed
- zero process overhead — no subprocess spawn
- standard practice (VS Code, iTerm2, kitty all use custom OSC for similar purposes)
- parsing pattern already exists in `pty-transport.ts` for terminal titles

Cons:

- cryptic visible tool calls — the user sees `printf '\x1b]9999;...\x07'` and has no idea what's happening
- fragile prompt contract — agents must get escape syntax exactly right
- if a tool call is required anyway (for rich summaries), there's no advantage over CLI
- adds PTY parser complexity for cross-chunk handling

Verdict:

Rejected in favor of CLI. The OSC transport is technically elegant but the UX is poor — the visible tool call is incomprehensible to users. Since rich summaries require a tool call regardless (hooks can't provide them), CLI via IPC is strictly better.

### 2. Parse terminal output strings

Example:

- scan recent output and try to infer `doing` / `next`

Pros:

- no agent changes required

Cons:

- brittle across agent types
- hard to distinguish narration from actual plan
- expensive if LLM-based
- easy to hallucinate stale or wrong status
- difficult to know when a task is truly done

Verdict:

Useful only as a last-resort fallback or later enhancement, not as the primary design.

### 3. Claude Code hooks

Example:

- use Claude Code hooks to push status automatically on prompt submit / completion

Pros:

- lower behavior burden for Claude Code specifically
- potentially very accurate for that one agent

Cons:

- only works for Claude Code
- does not solve Codex, Gemini, OpenCode, Aider, or future agents
- Orca would still need a general solution

Verdict:

Good optional optimization for Claude Code, but not the core design.

### 4. Terminal-title parsing only

Example:

- extend existing `working` / `permission` / `idle` detection

Pros:

- already partly implemented
- zero prompt overhead
- works across many agents if they expose useful titles

Cons:

- cannot reliably produce `what it is doing`
- cannot reliably produce `what it plans next`
- no history unless we store title changes, which is noisy and low quality
- many agents do not expose enough semantic detail in the title

Verdict:

Keep as fallback presence detection only.

### 5. Reuse `worktree.comment` with a formatting convention

Example:

- `doing: fix sidebar bug | next: run tests`

Pros:

- minimal implementation
- already persisted and rendered
- easy to trial quickly

Cons:

- no structured history
- requires parsing for UI improvements later
- encourages inconsistent formatting
- mixes user comments and agent status into one field

Verdict:

Rejected for this feature because `comment` is already a user-authored note surface in Orca.

### 6. Orca-specific skill

Example:

- install or inject a skill that tells agents how to update status

Pros:

- richer guidance than a one-line prompt
- useful for agent ecosystems that support skills well

Cons:

- not universal
- adds integration variance across agent types
- still needs a runtime status surface underneath

Verdict:

Useful as supporting adoption material, not as the main contract.

### 7. Sidecar summarizer process

Example:

- a local watcher reads terminal output and periodically summarizes progress into status

Pros:

- minimal agent cooperation
- can backfill status for legacy agents

Cons:

- implementation complexity
- summarization can be wrong or stale
- extra compute and token cost
- tricky privacy / trust story because it reads everything

Verdict:

Too much complexity for v1.

### 8. User-updated manual status only

Example:

- user edits worktree comment/status manually

Pros:

- trivial to support

Cons:

- does not solve agent visibility
- high user burden
- status goes stale quickly

Verdict:

Should remain possible, but not the answer to this problem.

## Recommended Decision

Build a **first-class Orca worktree status feature** with:

- explicit agent-to-Orca status reporting via `orca status set` CLI commands over Unix socket IPC
- `ORCA_PANE_KEY` env var injection in `pty:spawn` for pane attribution
- real-time renderer-only state (zustand slice, no persistence)
- per-agent skill/plugin adoption (e.g., `orca-status` skill for Claude Code)
- title heuristics as fallback
- a worktree status hover that shows all currently running agents

This is the lowest-risk design that still satisfies the actual goal. By keeping status ephemeral and renderer-only, we avoid the complexity of persistence, cleanup, and staleness TTLs. By using the CLI as the write path, the agent's tool calls are self-documenting to users, and the existing `RuntimeClient` IPC infrastructure handles transport with minimal new code.

## Concrete Next Step

If we decide to build this, I would implement in this order:

1. shared types for `AgentStatusEntry` and the zustand slice
2. `ORCA_PANE_KEY` env var injection in `pty:spawn`
3. `agentStatus.set` RPC handler in the runtime, forwarding to the renderer via IPC
4. `orca status set` CLI subcommand reading `ORCA_PANE_KEY` and calling the RPC
5. renderer-side IPC listener writing to the zustand slice
6. UI hover on the worktree status icon with explicit-over-heuristic precedence and freshness indicators
7. publish the `orca-status` skill and expose the install command in settings
