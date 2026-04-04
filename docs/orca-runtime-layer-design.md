# Orca Runtime Layer Design

## Goal

Define the shared runtime/orchestration layer that makes the Orca CLI's live terminal contract implementable.

This layer is required because the current codebase splits ownership across:

- Electron main process:
  - PTY process lifecycle
  - PTY IDs
  - PTY data and exit events
- Renderer:
  - tabs
  - split-pane layout
  - active pane
  - terminal titles
  - buffered offscreen writes
  - unread/activity side effects
- Persistence:
  - repo config
  - worktree metadata
  - saved terminal layout snapshots
  - saved tab state

That split is fine for the editor UI, but it is not enough for a CLI that needs:

- a stable `runtimeId`
- live terminal handles
- safe stale-handle rejection
- compact live summaries like `worktree ps`
- terminal reads and writes that do not depend on renderer-local pane IDs
- a real external transport path from the `orca` CLI into the running app

## Problem Statement

Today there is no single shared service that can answer:

- what live terminal targets currently exist
- which worktree/tab/leaf each target belongs to
- which PTY each target is connected to
- what a safe public handle for that live target should be
- whether a handle is still valid

Relevant current ownership:

- PTY ownership: [../src/main/ipc/pty.ts](../src/main/ipc/pty.ts)
- Renderer tab state: [../src/renderer/src/store/slices/terminals.ts](../src/renderer/src/store/slices/terminals.ts)
- Pane lifecycle and PTY connection: [../src/renderer/src/components/terminal-pane/use-terminal-pane-lifecycle.ts](../src/renderer/src/components/terminal-pane/use-terminal-pane-lifecycle.ts)
- Pane -> PTY wiring: [../src/renderer/src/components/terminal-pane/pty-connection.ts](../src/renderer/src/components/terminal-pane/pty-connection.ts)
- Leaf ID serialization: [../src/renderer/src/components/terminal-pane/layout-serialization.ts](../src/renderer/src/components/terminal-pane/layout-serialization.ts)

## Non-Goals

This runtime layer does not try to:

- replace the renderer store
- replace the PTY implementation
- make pane IDs durable across reloads
- implement every future terminal automation feature in one step

The first purpose is to provide a shared control plane for the current app and CLI.

## Current Constraints To Preserve

The design should stay honest about three existing realities:

1. Orca is effectively single-window today.
   The current PTY IPC wiring is attached to one `mainWindow` and forwards PTY data back through that window's `webContents`.

2. Leaf-level terminal state is not yet first-class renderer state.
   Today Orca persists tab-level state and layout snapshots, but it does not persist a canonical renderer-side record for each leaf's title, preview, or screen snapshot.

3. Hidden terminals already accumulate deferred output in the renderer.
   The runtime layer cannot assume every hidden leaf has a continuously updated visible-screen model without adding new explicit publication behavior.

This means the first runtime layer should optimize for correctness in the current single-window app before trying to generalize further.

## Core Design Principle

The runtime layer should be a main-process service that maintains a live registry built from:

- main-process PTY events
- renderer lifecycle registrations
- persisted repo/worktree metadata when useful

It should be the only place that:

- issues live terminal handles
- validates or rejects handles
- answers live summary queries
- exposes terminal read/write operations to the CLI

This avoids editor/CLI drift.

## Source Of Truth Boundaries

The runtime layer must not replace existing durable sources of truth.

Durable truth remains:

- Git for worktree existence and branch state
- `Store` persistence for repo config, worktree metadata, and saved session snapshots

Live truth becomes:

- runtime layer for terminal handles, live leaf/PTy mappings, and live summaries

This means:

- the runtime layer may cache and index persisted state
- but it should not become the canonical persistence owner for repo or worktree metadata
- renderer/UI code should stop inventing separate live-terminal contracts once the runtime layer exists

## Why Main Process Ownership

The runtime layer should live in the main process, not the renderer.

Reasons:

- the CLI will need to call into it even when no renderer component currently has focus
- PTY ownership already lives in the main process
- handle validation and stale-handle rejection are security and correctness boundaries
- renderer reloads should not destroy the authoritative registry object itself, even if they invalidate live handles

The renderer should publish registrations and updates into the runtime layer, not own the runtime layer.

Scope note:

- v1 runtime-layer design assumes one active Orca window
- multi-window support should be treated as a later extension, not an implicit requirement of the first implementation

## CLI Transport Boundary

The runtime layer also needs a transport boundary for the external CLI.

Recommendation:

- expose a local-only RPC endpoint from the main process
- use:
  - Unix domain socket on macOS/Linux
  - named pipe on Windows
- persist connection metadata in Orca user data:
  - `runtimeId`
  - endpoint path
  - auth token
  - pid

Suggested flow:

1. Orca main process starts the runtime service.
2. Orca opens the local RPC endpoint.
3. Orca writes connection metadata.
4. CLI reads connection metadata.
5. CLI connects locally and authenticates.
6. Runtime service handles CLI requests against the live registry.

Security properties:

- local machine only
- random auth token required
- stale pid/socket detection on startup

Why this matters:

- Electron renderer IPC is not the CLI transport
- the main process runtime service is the right authority for requests coming from the external CLI

## Runtime Identity

The runtime layer must generate a `runtimeId` when Orca launches.

Rules:

- `runtimeId` is unique per Orca process lifetime
- any full app restart creates a new `runtimeId`
- renderer reloads do not necessarily require a new `runtimeId`, but they may invalidate all live handles

Recommendation:

- keep `runtimeId` stable for the lifetime of the main Electron process
- separately track a renderer graph epoch that increments only when the renderer graph is explicitly reset or replaced in a way that breaks existing leaf mappings

Why:

- `runtimeId` is the coarse session identity exposed in CLI responses
- the renderer graph epoch is the finer invalidation boundary for ephemeral handles

CLI-facing simplification:

- handles are treated as ephemeral by default
- if the live graph is rebuilt in a way that invalidates mappings, all prior handles become stale

## Public Responsibilities

The runtime layer must support:

1. `status`
2. live terminal discovery
3. canonical selector resolution for CLI-facing repo/worktree lookups
4. handle issuance
5. handle validation
6. handle-based terminal reads
7. handle-based terminal writes
8. compact worktree live summaries

## Internal Data Model

The runtime layer should maintain the following registry objects.

### RuntimeState

```ts
type RuntimeState = {
  runtimeId: string
  rendererGraphEpoch: number
  graphStatus: 'ready' | 'reloading' | 'unavailable'
  authoritativeWindowId: number | null
}
```

### RegisteredTab

```ts
type RegisteredTab = {
  tabId: string
  worktreeId: string
  title: string | null
  activeLeafId: string | null
  layout: TerminalPaneLayoutNode | null
  lastSeenAt: number
}
```

### RegisteredLeaf

```ts
type RegisteredLeaf = {
  tabId: string
  worktreeId: string
  leafId: string
  paneRuntimeId: number
  ptyId: string | null
  ptyGeneration: number
  lastOutputAt: number | null
  lastExitCode: number | null
  preview: string
  tailBuffer: string[]
  connected: boolean
  writable: boolean
  lastSeenAt: number
}
```

### TerminalHandleRecord

```ts
type TerminalHandleRecord = {
  handle: string
  runtimeId: string
  rendererGraphEpoch: number
  worktreeId: string
  tabId: string
  leafId: string
  ptyId: string | null
  ptyGeneration: number
  createdAt: number
}
```

Why these fields matter:

- `leafId` gives stable layout identity within the current renderer graph
- `ptyId` is needed for actual write routing
- `ptyGeneration` prevents a restarted PTY in the same leaf from inheriting an old handle
- `tailBuffer` powers `terminal read`
- `preview` powers cheap discovery and `worktree ps`
- `writable` prevents CLI writes from racing against renderer-driven close or detach flows

## Handle Semantics

Handles are synthetic public identifiers issued by the runtime layer.

Rules:

- handles are opaque
- handles bind to:
  - `runtimeId`
  - `rendererGraphEpoch`
  - `worktreeId`
  - `tabId`
  - `leafId`
  - current `ptyId`
  - current `ptyGeneration`
- handles are invalid if:
  - `runtimeId` no longer matches
  - `rendererGraphEpoch` has advanced past the handle's epoch
  - the leaf registration no longer exists
  - the leaf now points at a different `ptyId` or `ptyGeneration`
  - the handle's current target cannot be resolved

This is intentionally strict.

Why:

- the CLI must never silently retarget input to a different live terminal
- handle invalidation should happen only for real remapping events, not every routine reconciliation pass

Stale-handle ergonomics:

- stale-handle errors should include the current `runtimeId`
- if the target leaf still exists but the specific handle is stale, the runtime layer may include a rediscovery hint scoped to that worktree or leaf
- the runtime layer should not implement a magical handle refresh that silently retargets the caller

## Event Sources

The runtime layer needs two classes of inputs.

### A. Main-process PTY events

Current source:

- [../src/main/ipc/pty.ts](../src/main/ipc/pty.ts)

Add runtime-layer integration points for:

- PTY spawned
- PTY data
- PTY exit
- PTY kill

What the runtime layer should record:

- `ptyId`
- PTY generation changes for a leaf
- data arrival timestamps
- exit code
- a bounded text tail buffer

### B. Renderer graph publication

The renderer already knows:

- when a tab exists
- what the saved and current layout is
- which leaf is active
- which pane has which current PTY
- titles derived from OSC updates

The runtime layer needs renderer-published graph state like:

- which tabs currently exist
- which leaves currently exist
- which worktree each tab belongs to
- which PTY each leaf is currently attached to
- which leaf is active within each tab
- what the current layout tree is for each tab

These are not current public APIs. They should be introduced as an explicit internal IPC channel.

Important source-of-truth rule:

- leaf records in the runtime registry are authoritative only when published by the renderer's full-graph sync
- persisted session state and renderer store state remain advisory inputs for tabs and worktrees, not a substitute for live leaf publication

## Suggested Internal IPC Contract

These are not CLI commands. They are editor-runtime plumbing.

### Renderer -> Main

- `runtime:syncWindowGraph`

Recommendation:

- start with one idempotent full-graph message as the source of truth for renderer-owned tab and leaf structure
- allow the renderer to resend the full graph whenever tab, layout, active-leaf, or PTY attachment state changes
- add narrower incremental messages later only if performance proves it necessary

Suggested payloads:

```ts
type RuntimeSyncWindowGraph = {
  windowId: number
  tabs: Array<{
    tabId: string
    worktreeId: string
    title: string | null
    activeLeafId: string | null
    layout: TerminalPaneLayoutNode | null
  }>
  leaves: Array<{
    tabId: string
    worktreeId: string
    leafId: string
    paneRuntimeId: number
    ptyId: string | null
  }>
}
```

Why payloads matter:

- this is where ownership boundaries become real
- if these messages stay vague, implementation will drift back into ad hoc IPC
- treat full-graph sync as both the normal publication path and the repair path if an earlier renderer event was missed

Single-window v1 rule:

- Orca should accept exactly one authoritative publishing window in v1
- if a second window starts publishing, the runtime layer should reject it or mark the graph unavailable until the conflict is resolved
- `windowId` exists to make that restriction explicit now and extensible later

### Main -> Renderer

Only if needed for editor features:

- `runtime:handleInvalidated`
- `runtime:statusChanged`

The initial version can keep the runtime layer mostly main-owned and query-driven.

## How The Renderer Should Integrate

The renderer should publish runtime graph snapshots from the same places that already own lifecycle.

Recommendation:

- start with event-driven full snapshot publication
- do not add granular register/update/remove messages unless profiling shows the full graph is too expensive
- build the sync payload in one renderer-side collector/helper, and let lifecycle sites only schedule that helper rather than hand-assembling payload fragments

Why:

- renderer lifecycle is complex
- split/close/reload sequences are easy places to lose one incremental event
- a full snapshot lets the main process repair drift instead of accumulating ghost leaves or stale mappings
- the initial implementation needs correctness more than minimal event chatter
- a single collector reduces the risk that `runtime:syncWindowGraph` logic gets duplicated across store and pane lifecycle code

### Tab lifecycle

Source:

- [../src/renderer/src/store/slices/terminals.ts](../src/renderer/src/store/slices/terminals.ts)

Integration:

- when a tab is created, changed, or closed, republish the full graph
- when layout snapshot changes, republish the full graph

### Leaf/pane lifecycle

Source:

- [../src/renderer/src/components/terminal-pane/use-terminal-pane-lifecycle.ts](../src/renderer/src/components/terminal-pane/use-terminal-pane-lifecycle.ts)
- [../src/renderer/src/components/terminal-pane/pty-connection.ts](../src/renderer/src/components/terminal-pane/pty-connection.ts)

Integration:

- on pane created or closed, republish the full graph
- on active pane change, republish the full graph
- on PTY spawn or detach, republish the full graph
- on PTY respawn for an existing leaf, republish the full graph and let the runtime layer advance `ptyGeneration`

### Why the code needs comments

When this runtime graph publication is added, it needs comments explaining why Orca duplicates renderer lifecycle into a main-process registry:

- the CLI needs a shared live control plane
- pane IDs are renderer-local and not safe as a public contract
- handle validation must not depend on renderer-local assumptions

Those are design-driven constraints and should be documented in code comments per `AGENTS.md`.

## How The Main PTY Layer Should Integrate

Current PTY code:

- [../src/main/ipc/pty.ts](../src/main/ipc/pty.ts)

Required additions:

- publish PTY spawn/exit/data events to the runtime service
- maintain a lightweight PTY registry accessible to the runtime service

Suggested PTY event shape:

```ts
type RuntimePtySpawned = {
  ptyId: string
  loadGeneration: number
}

type RuntimePtyData = {
  ptyId: string
  data: string
  at: number
}

type RuntimePtyExit = {
  ptyId: string
  exitCode: number
  at: number
}
```

The runtime service should not parse terminal DOM state. It should build read models from:

- PTY output bytes
- renderer registrations

## Selector Resolution Service

The runtime layer should own canonical selector resolution for repo and worktree selectors rather than leaving it to the CLI frontend.

Why:

- selector semantics are part of the public contract, not presentation glue
- if the CLI resolves selectors differently from editor-driven integrations, Orca will drift

This service should:

- accept tagged selectors like `id:`, `path:`, `branch:`, and `issue:`
- reject ambiguous bare values with structured ambiguity errors
- return stable repo or worktree identities that downstream runtime operations can use

The terminal layer should remain handle-first once discovery is complete, but selector resolution must still be runtime-owned for consistent discovery semantics.

## Single-Window Assumption In V1

The current app is effectively single-window, and the first runtime layer should embrace that instead of pretending multi-window support already exists.

Recommendation:

- one runtime service per app process
- one CLI target runtime per app process
- v1 should permit only one authoritative publishing window
- if multiple windows appear later, they may register into the same runtime service only after Orca has an explicit multi-window routing model

The runtime layer should not issue window-scoped handles.

## Terminal Read Model

`terminal show` and `terminal read` need cheap buffers.

The runtime layer should maintain:

- `preview`
- `tailBuffer`

### Preview

Purpose:

- cheap discovery
- worktree summary

Strategy:

- derived from most recent meaningful lines
- capped to a few hundred characters
- should be main-owned once PTY data reaches the runtime service

### Tail buffer

Purpose:

- powers `terminal read`

Strategy:

- bounded ring buffer by line count and char count
- updated from PTY output

### Visible screen snapshots

Visible screen snapshots should be treated as a later enhancement, not a required v1 runtime primitive.

Why:

- hidden panes currently accumulate deferred output in `pendingWritesRef`, so a renderer-owned "current screen" is not uniformly trustworthy across visible and hidden leaves
- the CLI needs an honest contract more than a more ambitious but misleading one

So:

- `terminal show` should rely on runtime-owned metadata plus preview
- initial `terminal read` should rely on runtime-owned PTY tail data only
- if Orca later adds explicit visible-screen publication, that can be layered on as an optional richer read mode rather than a v1 requirement

## Drift Recovery

The runtime layer should assume registrations can drift.

Examples:

- renderer reload before all leaf removals are delivered
- pane closes while PTY exit is also firing
- a restored tab graph replaces leaf IDs

Recovery strategy:

1. event-driven full graph sync for correctness
2. explicit epoch bump only when the renderer graph is reset or replaced incompatibly
3. reject stale handles instead of trying to preserve them through remaps

This is another reason handles should be treated as ephemeral by default.

## Reload And Unavailable States

The runtime layer needs an explicit graph-availability state rather than assuming the renderer graph is always present when PTYs exist.

Recommendation:

- enter `graphStatus: 'reloading'` when the authoritative renderer is tearing down or the window is reloading
- enter `graphStatus: 'unavailable'` if no authoritative renderer graph is available
- return to `graphStatus: 'ready'` only after a fresh successful `runtime:syncWindowGraph`

Why:

- the current PTY layer can briefly keep PTYs alive while the renderer graph is gone or rebuilding
- CLI calls should fail closed during that window instead of acting on stale registry state

Behavior:

- `terminal list`, `terminal show`, `terminal read`, and `terminal send` should reject with a distinct runtime-unavailable error while `graphStatus != 'ready'`
- `status` should still work and report why the live terminal graph is unavailable

## `worktree ps` Summary Model

`worktree ps` should be powered by the runtime layer, not persistence alone.

For each worktree, it should summarize:

- repo
- branch
- linked issue
- unread metadata
- live terminal count
- whether any terminal is attached to a live PTY
- last output time if known
- recent preview if useful

Recommendation:

- compute this in the runtime service from:
  - persisted worktree metadata
  - live tab/leaf registrations
  - PTY connectivity

Batch-read note:

- `worktree ps` is the preferred cheap batched live summary for many worktrees in v1
- Orca should avoid a second overlapping batch-preview primitive until real usage shows `worktree ps` is insufficient

The runtime layer should expose a single summary builder used by both:

- CLI `worktree ps`
- any future editor surfaces that want the same live summary semantics

Why:

- the CLI needs a cheap orchestration summary across many worktrees

## Wait Semantics

`terminal wait` needs to be split by what is actually observable.

### Safe first support

- `exit`

This can be grounded in PTY exit events.

### Later support requiring instrumentation or heuristics

- `output`
- `idle`
- `input`

Why:

- current code does not expose a first-class “waiting for input” state
- title heuristics exist in the renderer, but they are not sufficient as a strong CLI contract

Recommendation:

- runtime layer v1 supports only `wait --for exit`
- later phases may add:
  - output wait from PTY data arrival
  - idle wait from time-based quiescence
  - input wait from agent-specific instrumentation, not generic shell guessing

## Failure Modes And Safety Rules

### 1. Stale handles

Must fail explicitly.

Never silently redirect to:

- another leaf with the same title
- the current active leaf
- another PTY in the same tab

This includes PTY restarts inside the same leaf. A restarted process must not inherit an old handle.

### 2. Renderer reload

The current code already kills prior-generation PTYs on page reload in [../src/main/ipc/pty.ts](../src/main/ipc/pty.ts).

The runtime layer should treat renderer reload as a graph invalidation event:

- bump `rendererGraphEpoch`
- invalidate all old handles
- require fresh discovery

During the reload window:

- set `graphStatus` to `reloading`
- reject live terminal operations until a fresh graph sync completes

### 3. Missing renderer registrations

If the runtime layer has PTYs but no renderer graph for a target:

- `status` may report degraded runtime health
- but terminal discovery and live terminal operations must not surface orphan PTYs as valid targets

This should surface as capability truth, not silent omission.

### 4. Closing or detached targets

If a leaf is present in the graph but is no longer writable:

- mark it `writable: false`
- reject `terminal send`
- continue to allow metadata reads when useful

Why:

- current Orca shutdown and PTY replacement flows are partly renderer-driven
- the CLI should not race writes into a target that Orca is intentionally closing or detaching

V1 definition:

- `writable` should be computed from facts Orca can actually observe now
- a target is writable only when:
  - `graphStatus === 'ready'`
  - the leaf exists in the current authoritative graph
  - `ptyId != null`
  - the leaf is still marked `connected`
- if Orca later adds an explicit renderer-side closing or detaching marker, that can tighten `writable` further

## Proposed Implementation Phases

### Phase 1: Runtime identity and service skeleton

Deliver:

- `runtimeId`
- main-process runtime service object
- `status` support
- lifecycle wiring hooks only

### Phase 2: Local CLI RPC transport and runtime metadata

Deliver:

- local socket/pipe listener
- auth token bootstrap
- request/response envelope shared by the editor and CLI
- runtime metadata file in Orca user data

Why this comes early:

- the CLI contract depends on a real runtime transport boundary
- it is better to lock the transport and auth model before layering more command handlers on top

### Phase 3: Renderer graph sync and PTY event ingestion

Deliver:

- `runtime:syncWindowGraph`
- tab/leaf graph registry
- PTY attach/detach mapping
- tail buffer updates from PTY events
- preview generation

### Phase 4: Handle issuance and validation

Deliver:

- handle generation
- handle lookup
- stale-handle rejection
- replacement hints in stale-handle errors when safe
- `terminal list`
- `terminal show`

### Phase 5: Read and write surface

Deliver:

- main-owned tail ring buffer
- `terminal read`
- `terminal send`
- `graphStatus`-aware rejection during reload and unavailable windows

### Phase 6: Summary service

Deliver:

- `worktree ps`

### Phase 7: Optional richer terminal reads

Deliver:

- renderer-published visible screen snapshots if Orca proves it needs them

### Phase 8: Wait support beyond exit

Deliver:

- `wait --for exit`
- explicitly defer the rest until instrumentation exists

## Recommended File/Module Shape

Main process:

- `src/main/runtime/orca-runtime.ts`
- `src/main/ipc/runtime.ts`

Renderer integration:

- `src/renderer/src/runtime/sync-runtime-graph.ts`
- targeted calls from:
  - `terminals.ts`
  - `use-terminal-pane-lifecycle.ts`
  - `pty-connection.ts`

Why separate files:

- start with one runtime service and one IPC entrypoint so the design stays easy to land
- split handle, registry, and buffer helpers into separate modules later only if the implementation earns that complexity

## Open Questions

1. Should `runtimeId` change only on app restart, or also on explicit renderer graph reset?

Recommendation:

- app restart only
- use `rendererGraphEpoch` for graph invalidation

2. Should handles encode any meaning, or be fully opaque?

Recommendation:

- fully opaque

3. Should visible screen snapshots be pushed continuously or only on demand if Orca adds them later?

Recommendation:

- defer this until after the tail-buffer-based runtime contract is stable
- if added later, start with on-demand or throttled publication for visible leaves only

4. Should terminal previews come from screen snapshots or tail buffers?

Recommendation:

- use tail buffer for preview generation
- reserve visible screen snapshots for an optional richer read mode later

5. Should Orca support more than one publishing window in v1?

Recommendation:

- no
- keep one authoritative publishing window until PTY routing and renderer graph ownership are explicitly multi-window-safe

## Recommendation

Build the runtime layer as a main-process orchestration service with:

- stable `runtimeId`
- renderer-published full tab/leaf graph sync
- PTY-event integration
- local CLI RPC transport
- opaque handle issuance
- strict stale-handle rejection
- bounded read models for discovery and terminal reads

That is the smallest honest architecture that can support the Orca CLI's live terminal contract without drifting from the editor.
