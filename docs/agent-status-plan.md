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

**Decision:** Use **OSC escape sequences as the sole transport** for agent-reported status, parsed in the renderer's PTY transport layer. Status is real-time only — it lives in renderer memory and is not persisted to disk. See the [Transport Mechanism](#transport-mechanism) section below for the rationale.

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

The design relies on per-pane attribution so the hover can show multiple concurrently running agents in one worktree — including split panes within the same tab. This is one of the strongest reasons to prefer OSC as the write path: the PTY stream already tells Orca exactly which tab and pane is reporting.

Because status lives only in renderer memory keyed by `paneKey`, there is no orphan cleanup problem. When a pane's terminal exits, its entry is removed; when a tab closes, all its pane entries are swept by prefix (same pattern as `cacheTimerByKey` cleanup in `closeTab`). When the renderer reloads, the zustand store starts fresh — no stale entries, no sweep logic, no lifecycle reconciliation. This is a direct consequence of choosing renderer-only state over persistence.

### Why No CLI Surface

An earlier version of this design included `orca worktree status show` for read/debug access and `orca worktree status set` as an alternative write path. Both were dropped:

- **No CLI read path**: with renderer-only state, there is nothing for the CLI to read. Status lives in the zustand store, not in a persisted file or runtime RPC. The hover UI is the read surface.
- **No CLI write path**: OSC is strictly better for agent-originated writes (free terminal attribution, free worktree resolution, zero process overhead). A CLI write path would require `ORCA_TERMINAL_HANDLE` env var injection, handle remapping after renderer reloads, and subprocess spawn overhead — all to solve an attribution problem that OSC solves for free.
- **Debuggability**: the hover UI provides the same visibility that `status show` would have. For developer debugging during implementation, the zustand devtools or a simple console log in the OSC parser is sufficient.

## Transport Mechanism

The transport question is settled: **OSC escape sequences are the sole write path** for agent-reported status. This section documents the rationale and the alternatives that were considered.

### OSC Escape Sequences

Agents print a custom OSC (Operating System Command) escape sequence to stdout:

```
printf '\x1b]9999;{"state":"working","summary":"...","next":"..."}\x07'
```

Orca's PTY parser — which already processes all terminal output — detects and extracts the payload.

How it works:

- Agent prints a string containing the ESC byte (`0x1B`), a custom OSC code, a JSON payload, and a BEL terminator (`0x07`)
- Orca's renderer-side PTY transport layer (`pty-transport.ts`) — which already processes all terminal output and parses OSC title sequences — pattern-matches the status OSC sequence and extracts the JSON
- The PTY transport already knows which tab produced the data, so tab attribution is free
- The renderer already knows which worktree owns each tab, so worktree resolution is free
- The parsed payload goes straight into a zustand slice; the hover UI reads from it

Why parsing happens in the renderer, not the main process: Orca already parses OSC title sequences in `pty-transport.ts` on the renderer side. Status parsing is the same pattern — a richer version of what already exists. There is no reason to involve the main process when the renderer already has the PTY data stream, the tab identity, and the zustand store that the UI reads from.

Advantages:

- **no `ORCA_TERMINAL_HANDLE` plumbing needed** — Orca already knows which PTY produced the output, so terminal attribution is inherent. This eliminates the env var injection, the handle remapping after renderer reload, and the chicken-and-egg ordering problem. A significant chunk of the CLI approach's complexity exists specifically to solve "who is calling?"
- **no worktree resolution** — Orca already knows which worktree owns each PTY, so the expensive `resolveCurrentWorktreeSelector` enumeration is avoided entirely
- **zero process overhead** — no subprocess spawn, no RPC connection, no socket negotiation
- **simpler agent instruction** — "print this string" vs "run this CLI command with these flags and env vars"
- **standard practice** — VS Code uses custom OSC sequences for shell integration (command detection, cwd tracking), iTerm2 uses them for inline images and notifications, kitty uses them for its graphics protocol. Orca already parses terminal titles via OSC sequences today — this is a richer version of the same pattern
- **no false positive risk** — the ESC byte (`0x1B`) is a non-printable control character. Normal agent text output (JSON, logs, code) produces printable ASCII/UTF-8 characters. The only way to emit the actual ESC byte is through `printf` or equivalent, meaning an agent must deliberately use the protocol

Tradeoffs accepted:

- **not debuggable from a plain shell** — you can technically run `printf '\x1b]9999;...\x07'` but it is less discoverable than a CLI command. In practice, the hover UI is the read surface and zustand devtools suffice for development debugging.
- **only works inside Orca-managed PTYs** — external scripts or CI cannot use this path. This is acceptable because agent status is inherently scoped to Orca-managed terminals; an external script reporting status into a worktree it is not running in would be misleading.
- **PTY parser complexity** — need to carefully parse the OSC sequence from the byte stream, handle partial reads across chunks, and strip the sequence before it reaches the terminal emulator. However, Orca already does this for OSC title sequences in `pty-transport.ts`, so the pattern is established.

### Why Not CLI Commands (Considered and Rejected)

An alternative considered was using CLI commands (`orca worktree status set --state working --summary "..."`) as the write path. This was rejected because:

- it requires `ORCA_TERMINAL_HANDLE` env var injection into every Orca-managed PTY (does not exist today, needs plumbing in `pty:spawn`)
- env vars are immutable from outside the process, so handle remapping is needed after renderer reloads when surviving terminals still reference stale handles
- `resolveCurrentWorktreeSelector` is expensive (enumerates all worktrees), needs a caching fast path
- subprocess spawn overhead per status call (minor given the 5-15 minute cadence, but still unnecessary)
- a significant chunk of the CLI approach's complexity exists specifically to solve "who is calling?" — a problem that OSC solves for free

The CLI's main advantage was debuggability (`status show` for reading, `status set` for testing), but with renderer-only state the CLI cannot read status anyway, and the hover UI provides the same visibility.

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

Use **OSC escape sequences as the sole transport** for agent-reported status. No CLI write path, no CLI read path.

Why:

- tab attribution is inherent on the PTY stream, so Orca does not need env-var handle injection
- worktree ownership is already known by the renderer, so status writes do not need a `cwd -> worktree` lookup
- agent writes stay lightweight and do not spawn subprocesses
- parsing happens in `pty-transport.ts` alongside existing OSC title parsing — no main process involvement
- status goes straight into a zustand slice, the hover UI reads from it
- with renderer-only state, there is nothing for a CLI to read or persist

The rest of this document therefore assumes:

- status writes arrive as OSC payloads on the PTY stream, parsed in the renderer
- the hover UI is the read surface for status
- heuristics remain the fallback when an agent does not emit explicit status

## Prompt / Skill Strategy

I would **not** make this a skill-only feature.

Skills are useful for some agents, but they are not the universal contract across all agent types. The stable contract should be:

- Orca runtime data model
- a reporting mechanism (OSC escape sequence — see [Transport Mechanism](#transport-mechanism))
- tiny instruction injected by Orca when launching an agent

Recommended injected instruction:

> When you reach a meaningful checkpoint, update Orca with a short status by printing: `printf '\x1b]9999;{"state":"working","summary":"...","next":"..."}\x07'`. Use state "done" when finished. Do not update on every trivial command.

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

### Phase 1: Transport + Renderer State

- add OSC 9999 parsing in `pty-transport.ts` alongside existing OSC title parsing
- add a zustand slice (`agentStatusByPaneKey`) for parsed status entries
- define payload normalization (single-line, max length, truncation)
- ensure status updates do **not** bump `lastActivityAt` or reorder worktrees on every checkpoint
- clean up entries when panes exit or tabs close (prefix-sweep on `${tabId}:`, matching `cacheTimerByKey` cleanup)

Success criteria:

- an agent can report status via `printf '\x1b]9999;{"state":"working","summary":"...","next":"..."}\x07'`
- the renderer parses the OSC payload and stores it in the zustand slice keyed by `paneKey` (`${tabId}:${paneId}`)
- the OSC sequence is stripped before it reaches the terminal emulator
- status writes do not clobber user comments or create sort churn

### Phase 2: UI

- render a hover on the worktree status icon that shows all currently running agents in the worktree
- show done state clearly
- preserve existing heuristic active/permission badges
- show freshness indicators for entries that have not been updated recently

Success criteria:

- a user can tell at a glance whether a worktree is active from the icon
- hovering the icon reveals exactly what each running agent is doing and what it plans next

### Phase 3: Agent Adoption

- inject the short instruction into Orca-launched agents
- add agent-specific launch wrappers only where needed
- document the status contract

Success criteria:

- Claude Code, Codex, Gemini, OpenCode, and Aider launched via Orca can all report status
- unsupported/manual terminals still degrade gracefully via heuristics

## Alternatives

### 1. Parse terminal output strings

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

### 2. Claude Code hooks

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

### 3. Terminal-title parsing only

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

### 4. Reuse `worktree.comment` with a formatting convention

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

### 5. Orca-specific skill

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

### 6. Sidecar summarizer process

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

### 7. User-updated manual status only

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

- explicit agent-to-Orca status reporting over OSC escape sequences, parsed in the renderer
- real-time renderer-only state (zustand slice, no persistence)
- prompt injection for agent adoption
- title heuristics as fallback
- a worktree status hover that shows all currently running agents

This is the lowest-risk design that still satisfies the actual goal. By keeping status ephemeral and renderer-only, we avoid the complexity of persistence, cleanup, staleness TTLs, and CLI plumbing — while still giving users the visibility they need into what agents are doing right now.

## Concrete Next Step

If we decide to build this, I would implement in this order:

1. shared types for `AgentStatusEntry` and the zustand slice
2. OSC 9999 parsing in `pty-transport.ts` — extract JSON payload, write to zustand slice, strip sequence before render
3. UI hover on the worktree status icon with explicit-over-heuristic precedence and freshness indicators
4. launch-time prompt injection for supported agents
5. optional Claude Code hook optimization later
