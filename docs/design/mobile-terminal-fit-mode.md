# Design: Mobile Fit Mode for Live Terminals

**Status:** Draft  
**Author:** Codex  
**Date:** 2026-04-28

## Problem

The mobile app currently mirrors the desktop terminal by subscribing to the live PTY stream and initializing mobile xterm with the desktop terminal's `cols` and `rows`. This preserves TUI correctness because programs like Claude Code, Ink, and curses apps emit cursor-positioning escape sequences against the PTY grid they were rendered in.

That correctness comes with a bad phone experience: a desktop-sized terminal can be 140+ columns wide, so mobile either scales it down until text is tiny or requires horizontal panning.

Client-side reflow is not viable. If mobile renders the same PTY output at a different grid size without resizing the actual PTY, TUI absolute positioning and alternate-screen layouts become corrupt.

## Goal

Add an explicit mobile action that resizes the real desktop-owned PTY to dimensions that fit the phone, then lets mobile render the terminal normally at those dimensions.

The user-facing behavior:

1. User opens a terminal in the mobile app.
2. User taps a `Fit to Phone` action.
3. The desktop terminal's PTY receives the phone-sized `cols` and `rows`.
4. TUIs repaint for the phone-sized grid.
5. Mobile subscribes to the resized PTY and displays it without squeezing a desktop layout.
6. User can restore the previous desktop size.

## Non-Goals

- Do not render two independent PTY sizes for one process. A PTY has one authoritative grid.
- Do not client-side reflow serialized xterm output.
- Do not resize the desktop window or split pane geometry.
- Do not silently enter phone-fit mode when opening a terminal. It should be explicit because it changes the desktop view too.

## Existing Architecture

Relevant current paths:

| Area | File | Current behavior |
| --- | --- | --- |
| Mobile terminal mirror | `mobile/src/terminal/TerminalWebView.tsx` | Initializes xterm with server-reported `cols`/`rows`, then scales the rendered surface to phone width. |
| Mobile session | `mobile/app/h/[hostId]/session/[worktreeId].tsx` | Calls `terminal.subscribe`, writes scrollback/live data into `TerminalWebView`, and can focus/create/rename/close terminals. |
| RPC methods | `src/main/runtime/rpc/methods/terminal.ts` | Exposes `terminal.list`, `terminal.send`, `terminal.create`, `terminal.focus`, `terminal.close`, `terminal.subscribe`; no resize method yet. |
| Runtime terminal handles | `src/main/runtime/orca-runtime.ts` | Resolves terminal handles to live leaves or fallback PTY records, and exposes `getTerminalSize()`/`serializeTerminalBuffer()`. |
| Main PTY controller | `src/main/ipc/pty.ts` | Owns provider routing for PTY write/kill/serialize/getSize. Existing renderer IPC `pty:resize` already routes to local or SSH providers. |
| Desktop PTY resize | `src/renderer/src/components/terminal-pane/pty-connection.ts` | `pane.terminal.onResize` calls `transport.resize(cols, rows)`, which resizes the PTY. |
| Desktop auto-fit | `src/renderer/src/components/terminal-pane/use-terminal-pane-global-effects.ts` | Sidebar/layout/container changes call `fitAllPanes()` or `fitPanes()`, which can resize desktop xterm and therefore the PTY. |

Current data flow:

```
[Desktop xterm pane] --onResize--> [PTY provider] --output--> [Runtime terminal.subscribe]
        ↑                                                          ↓
   fitAddon.fit()                                           [Mobile xterm mirror]
```

Proposed data flow:

```
[Mobile terminal view]
        ↓ measured phone cols/rows
[terminal.resizeForClient RPC]
        ↓
[OrcaRuntimeService resolve handle -> ptyId]
        ↓
[RuntimePtyController.resize()]
        ↓
[PTY provider resize + SIGWINCH]
        ↓
[TUI repaints at phone grid]
        ↓
[terminal.subscribe / serializeBuffer]
        ↓
[Mobile xterm renders phone-sized grid]

[Desktop xterm pane]
        ↓
["mobile fitted" override suppresses automatic fit-to-pane PTY resize]
```

## Design

### 1. Add Runtime PTY Resize Support

Extend the main-process runtime controller:

```ts
type RuntimePtyController = {
  write(ptyId: string, data: string): boolean
  kill(ptyId: string): boolean
  resize?(ptyId: string, cols: number, rows: number): boolean
  listProcesses?(): Promise<{ id: string; cwd: string; title: string }[]>
  serializeBuffer?(ptyId: string): Promise<{ data: string; cols: number; rows: number } | null>
  getSize?(ptyId: string): { cols: number; rows: number } | null
}
```

Wire `resize` into the existing runtime controller installed by `registerPtyHandlers()` in `src/main/ipc/pty.ts`. This is not a new renderer IPC path. It should use the same provider routing and size cache behavior as the current `pty:resize` handler:

1. `ptySizes.set(ptyId, { cols, rows })`
2. `getProviderForPty(ptyId).resize(ptyId, cols, rows)`
3. return `true` on success and `false` if provider lookup or resize throws.

This should support local, daemon, and SSH PTYs because the existing provider interface already has `resize(id, cols, rows): void`.

### 2. Add a Terminal Resize RPC

Add `terminal.resizeForClient` in `src/main/runtime/rpc/methods/terminal.ts`.

Proposed params:

```ts
type TerminalResizeForClientParams =
  | {
      terminal: string
      mode: 'mobile-fit'
      cols: number
      rows: number
      clientId: string // opaque mobile session/connection identifier
    }
  | {
      terminal: string
      mode: 'restore'
      clientId: string
    }
```

Validation:

- `mobile-fit` requires `cols` and `rows` as finite positive integers.
- Clamp `mobile-fit` dimensions to a conservative supported range, for example `20 <= cols <= 240`, `8 <= rows <= 120`, and return the normalized dimensions.
- `restore` requires only `terminal`.
- Accept handles that resolve to a connected PTY, whether from a live renderer leaf or a fallback PTY record.
- Reject handles with no connected PTY.

Runtime return:

```ts
{
  terminal: {
    handle: string
    cols: number
    rows: number
    previousCols?: number
    previousRows?: number
    mode: 'mobile-fit' | 'desktop-fit'
  }
}
```

### 3. Track Mobile-Fit State in Runtime

Add an in-memory map in `OrcaRuntimeService`:

```ts
private terminalFitOverrides = new Map<
  string,
  {
    mode: 'mobile-fit'
    cols: number
    rows: number
    previousCols: number | null
    previousRows: number | null
    updatedAt: number
    clientId: string // mobile session/connection ID that owns this override
  }
>()
```

Key by `ptyId`, not terminal handle, because handles can be reissued while the PTY identity is stable.

**Multi-client policy: latest writer wins.** If multiple mobile clients call `resizeForClient` on the same terminal, each call overwrites the previous override (including `clientId`, `cols`, `rows`, and `updatedAt`). A `restore` call is only accepted from the `clientId` that currently owns the override — this prevents one phone from undoing another phone's active fit. If the owning client disconnects (see Section 7), any remaining client may issue a new `resizeForClient` to take ownership, or the override auto-restores. This is the simplest correct policy because the PTY has exactly one grid size at any moment; trying to merge or queue multiple phone sizes would add complexity with no user benefit.

This state is intentionally in-memory. If the desktop app restarts, PTYs either reconnect through existing session restore or get new renderer sizing; restoring a stale phone override after restart would be surprising.

### 4. Prevent Desktop Auto-Fit From Immediately Undoing Mobile Fit

A raw PTY resize RPC is not sufficient. The desktop renderer currently fits terminals to pane geometry:

- `safeFit()` calls `fitAddon.fit()`, which directly resizes desktop xterm.
- Pane-local `ResizeObserver` callbacks call `safeFit()`.
- `pane.terminal.onResize` sends every xterm resize to the PTY.
- `fitAllPanes()` and `fitPanes()` call xterm fit logic after layout changes.
- Connect/replay paths call `transport.resize(cols, rows)` after fitting.

When a PTY is in mobile-fit mode, the desktop pane must not auto-resize that PTY back to desktop dimensions. Suppressing `transport.resize()` alone is not enough: desktop xterm could still become desktop-sized while the underlying PTY stays phone-sized, and later serialized snapshots could report the wrong dimensions.

Add a main-to-renderer fit override signal. `syncWindowGraph()` is renderer-to-runtime, so it cannot be the primary channel for runtime-owned fit state to reach the desktop renderer.

Use an explicit runtime IPC channel instead:

1. `terminal.resizeForClient` updates `OrcaRuntimeService.terminalFitOverrides`.
2. Runtime/main sends a `runtime:terminalFitOverrideChanged` event to the authoritative window with `{ ptyId, mode, cols, rows }`.
3. The renderer stores overrides by `ptyId` in Zustand or a small terminal-pane state module.
4. Terminal pane resize/connect code reads that state before forwarding xterm resizes to the PTY.

Concrete IPC additions:

- Extend `RuntimeNotifier` with `terminalFitOverrideChanged(...)`.
- Implement it in `src/main/window/attach-main-window-services.ts` by sending `runtime:terminalFitOverrideChanged` to the authoritative `BrowserWindow`.
- Add preload APIs:
  - `window.api.runtime.onTerminalFitOverrideChanged(callback)`
  - `window.api.runtime.getTerminalFitOverrides()`
- Add a renderer hydration step before terminal panes run their first attach/fit logic.
- No acknowledgement round-trip is required before PTY resize. `RuntimeNotifier` is fire-and-forget, so adding an ack would require a separate IPC round-trip that adds complexity disproportionate to the risk. The race window is small: the renderer must process the override event before its next fit cycle fires. If a race does occur (renderer fits before it sees the override), the mobile resubscribe will detect a dimension mismatch and can re-request fit, which is self-correcting. The fallback path (no leaf mounted, resize immediately) already covers the most important case.

The query path is required so a renderer reload or late-mounting pane can hydrate current overrides.

Desktop behavior while mobile-fit is active:

- Treat mobile-fit as a pane-manager fit policy, not only a PTY transport guard.
- **`safeFit()` in `pane-tree-ops.ts` is the primary choke point** for most desktop fit operations. The override check belongs inside `safeFit()` (or in `getProposedDimensions()` which it calls), so callers that route through it inherit mobile-fit suppression automatically.
- **Prerequisite: consolidate all `fitAddon.fit()` callers through `safeFit()`.** There are currently 4 direct `fitAddon.fit()` call sites that bypass `safeFit()` entirely. Before implementing the override check, these must be refactored to route through `safeFit()` (or a shared helper that includes the override check):
  1. `src/renderer/src/components/terminal-pane/pty-connection.ts:349` — `connectPanePty` rAF path calls `fitAddon.fit()` directly during initial attach.
  2. `src/renderer/src/components/terminal-pane/expand-collapse.ts:111` — pane expand/collapse animation calls `fitAddon.fit()` directly.
  3. `src/renderer/src/components/terminal-pane/useTerminalFontZoom.ts:55` — font zoom handler calls `fitAddon.fit()` directly after font size change.
  4. `src/renderer/src/components/terminal-pane/terminal-appearance.ts:224` — appearance change handler calls `fitAddon.fit()` directly.
- **Prerequisite: make explicit `transport.resize()` calls override-aware.** Two sites unconditionally call `transport.resize(cols, rows)` with desktop-derived dimensions and must check for an active mobile-fit override:
  1. `src/renderer/src/components/terminal-pane/pty-connection.ts:577` — reattach path sends desktop dims after replay.
  2. `src/renderer/src/components/terminal-pane/terminal-appearance.ts:231` — appearance change handler sends `pane.terminal.cols/rows` after its `fitAddon.fit()` call.
  Both must use override dimensions when a mobile-fit override is active for the PTY; otherwise they silently undo the phone fit.
- Once these bypass paths are consolidated, `safeFit()` becomes the true single choke point. When `safeFit()` detects an active override for the pane's `ptyId`, it should skip `fitAddon.fit()` and instead call `pane.terminal.resize(mobileCols, mobileRows)` directly. All of the following paths are then covered by this single interception point:
  - `fitAllPanes()` / `refitPanesUnder()` (call `safeFit()`)
  - pane-local fit `ResizeObserver` (calls `safeFit()`)
  - global sync-fit and debounced container resize paths (call `safeFit()`)
  - connect/reattach initial dimension calculation (calls `safeFit()`)
  - terminal appearance changes in `terminal-appearance.ts` (routed through `safeFit()` after prerequisite refactor)
  - terminal font zoom in `useTerminalFontZoom.ts` (routed through `safeFit()` after prerequisite refactor)
  - pane expand/collapse in `expand-collapse.ts` (routed through `safeFit()` after prerequisite refactor)
  - `connectPanePty` rAF in `pty-connection.ts` (routed through `safeFit()` after prerequisite refactor)
- For fitted PTYs, skip `fitAddon.fit()` and explicitly call `pane.terminal.resize(mobileCols, mobileRows)` under an `ignoreNextResizeForwardRef` guard so `onResize` does not echo the resize back to the PTY unnecessarily.
- Suppress or ignore PTY resize forwarding from `onResize` only while the resize originated from applying the override.
- Use mobile dimensions for connect, reattach, snapshot replay, and any explicit `transport.resize(cols, rows)` while the override is active.
- Hydrate override state before `connectPanePty`'s first animation-frame fit/attach logic runs. Otherwise the first attach can compute desktop dimensions and undo mobile-fit before the override is visible locally.
- The desktop xterm grid must remain at mobile `cols`/`rows` so the desktop display, renderer serializer, and PTY agree on one grid.
- The desktop pane itself keeps its pixel size. Any unused space should remain terminal background, aligned top-left.
- Show a dismissible banner at the top of the affected terminal pane: **"Terminal resized for phone — [Restore]"**. The banner should be clearly visible (not a subtle badge) because the desktop user needs to understand immediately why their terminal looks different — an unexplained narrow grid would appear broken. The `[Restore]` action calls `terminal.resizeForClient` with `mode: 'restore'`. The banner auto-dismisses when the override is cleared by any path (explicit restore, mobile disconnect, PTY exit).

If the target is a fallback PTY with no mounted desktop leaf, runtime can still resize the PTY. The desktop indicator and fit suppression apply when the leaf later mounts and hydrates the override from runtime.

### 5. Mobile Measurement

Mobile must compute a character grid from actual terminal viewport dimensions, not from screen size alone.

Add measurement support to `TerminalWebView`:

- After xterm opens, measure character cell width and height from xterm internals or a hidden monospace probe.
- Measure available WebView width/height after terminal frame and input/accessory bars are laid out.
- Compute:

```ts
cols = Math.floor(availableWidth / cellWidth)
rows = Math.floor(availableHeight / cellHeight)
```

Use the same mobile terminal font size intended for readable, unscaled display. The initial target should prioritize readability, not maximum information density.

Note: measurement requires extending the WebView-injected JavaScript and adding a two-way message bridge between React Native and the WebView. The RN side sends a measurement request via `webViewRef.injectJavaScript()` (or `postMessage`), the WebView JS measures xterm internals and posts the result back via `window.ReactNativeWebView.postMessage()`, and the RN side resolves a Promise-based handle on the `onMessage` callback. This bridge does not exist today and must be built as part of the `measureFitDimensions()` contract.

### 6. Mobile UX

Add the action to the terminal long-press menu:

- `Fit to Phone`
- `Restore Desktop Size` when an override is active
- Existing `Rename`
- Existing `Close`

Also consider a small icon button in the terminal top bar later, but start with the menu to avoid clutter.

State handling:

- While resize is pending, disable the action and keep the current terminal visible.
- On success, clear and resubscribe so mobile receives fresh serialized scrollback at the new dimensions.
- The post-fit resubscribe path must skip `terminal.focus` entirely. The terminal is already focused — the resize was applied by runtime, not by a focus change. Re-focusing would trigger the desktop attach/fit sequence, which races with the override because the override notification is fire-and-forget (no ack round-trip). Skipping focus removes the race entirely and is correct because focus state did not change.
- On failure, show a compact error in the session screen and keep the current subscription.
- If the terminal is closed while fit is active, discard the override.

`TerminalWebView` should expose a concrete measurement contract:

```ts
type TerminalWebViewHandle = {
  write(data: string): void
  init(cols: number, rows: number): void
  clear(): void
  measureFitDimensions(): Promise<{ cols: number; rows: number } | null>
}
```

The measurement becomes valid after WebView `web-ready`, xterm open, and the React Native terminal frame has emitted layout dimensions. If any measurement is missing or below the minimum supported grid, disable `Fit to Phone` for that terminal and keep the existing mirror behavior.

### 7. Restore Semantics

On first `mobile-fit`, record the previous PTY size from `getTerminalSize(ptyId)` or serialized buffer dimensions.

`restore` should:

1. Clear the runtime fit override.
2. Send `runtime:terminalFitOverrideChanged` with `mode: 'desktop-fit'` to the authoritative renderer.
3. Renderer clears local override state for that PTY.
4. If a desktop pane is mounted, renderer immediately runs a targeted fit for the affected pane and lets that fit resize the PTY to current desktop pane geometry.
5. If no desktop pane is mounted, runtime resizes the PTY back to the recorded previous size when available.

The restore path has one authority at a time: mounted renderer pane geometry wins; recorded previous size is only a fallback for unmounted/fallback PTYs. This avoids double resizing and duplicate SIGWINCH delivery when desktop pane size changed while mobile-fit was active.

#### Transport-layer prerequisites for disconnect detection

The auto-restore-on-disconnect behavior described below requires connection lifecycle plumbing that does not exist today. The WebSocket transport and RPC dispatcher currently have no connection-scoped state, no `clientId` tracking, and no close handler. The following changes are required before auto-restore can work:

1. **`WebSocketTransport.handleConnection()` must register a `ws.on('close')` handler** for each accepted WebSocket connection. Today the handler only wires `ws.on('message')` — there is no close/disconnect callback.
2. **Each WebSocket connection gets a `clientId`**, derived from the mobile `deviceToken` sent during handshake (preferred, because it is stable across reconnects) or minted as a UUID at connect time if no token is provided.
3. **Transport or `OrcaRuntimeRpcServer` notifies `OrcaRuntimeService` of connection close.** Add a `onClientDisconnected(clientId: string)` callback (or event) that fires when the `ws.on('close')` handler runs. This is the bridge between the transport layer and runtime-owned state.
4. **`OrcaRuntimeService.onClientDisconnected(clientId)`** walks `terminalFitOverrides`, finds all entries whose `clientId` matches the disconnected session, and runs the restore path (steps 1–5 above) for each.

These changes are scoped to `src/main/runtime/rpc/` (transport and dispatcher) and `src/main/runtime/orca-runtime.ts` (service). `RpcDispatcher` does not need a full connection lifecycle concept — it only needs to forward the close signal with the associated `clientId`.

Cleanup:

- **Auto-restore on mobile disconnect:** When a mobile RPC session disconnects (WebSocket close), runtime should iterate `terminalFitOverrides` and auto-restore any overrides whose `clientId` matches the disconnected session. This prevents orphaned phone-fit state on desktop when the phone loses connectivity or the user closes the app. The `clientId` tracked in the override state (Section 3) makes this lookup straightforward. Auto-restore follows the same restore logic described above (steps 1–5). This depends on the transport-layer prerequisites described above.
- `OrcaRuntimeService.onPtyExit()` clears any override for the exited `ptyId`.
- `terminal.close` and terminal stop/worktree shutdown paths clear overrides for affected PTYs.
- Runtime sends a `desktop-fit`/clear event if the authoritative renderer may still have local override state for that PTY.

### 8. Tests

Unit tests:

- `src/main/runtime/orca-runtime.test.ts`
  - `mobile-fit` clamps valid dimensions and rejects missing/non-finite dimensions.
  - `restore` accepts no dimensions.
  - resize resolves handles from live leaves.
  - resize resolves fallback PTY handles.
  - resize records previous size.
  - restore clears override.
  - restore from non-owning `clientId` is rejected.
  - second `resizeForClient` from different `clientId` overwrites previous override.
  - mobile session disconnect auto-restores overrides owned by that session.
  - PTY exit/close clears override.
  - `WebSocketTransport` `ws.on('close')` fires `onClientDisconnected` with the correct `clientId`.

- `src/main/runtime/rpc/methods/terminal.ts` tests or RPC dispatcher tests
  - schema rejects missing/invalid params.
  - RPC returns normalized dimensions.

- `src/main/ipc/pty.test.ts`
  - runtime `resize` routes through provider dispatch.
  - `ptySizes` cache updates.

Renderer tests:

- `safeFit()` applies override dimensions instead of `fitAddon.fit()` for fitted PTYs (single choke point covers all callers).
- Pane-local and global fit paths keep desktop xterm at mobile dimensions while override is active (verified via `safeFit()` interception).
- Connect/reattach uses override dimensions before spawn/attach/replay resize calls.
- Reattach path: `transport.resize(cols, rows)` in `pty-connection.ts` uses override dimensions (not desktop-derived dimensions) when a mobile-fit override is active for the PTY.
- Appearance changes and font zoom do not break mobile-fit or forward desktop dimensions to the PTY while fitted.
- Renderer serializer reports dimensions matching the fitted PTY.
- Restore clears override state and immediately runs targeted desktop fit.

Mobile tests:

- `TerminalWebView` reports measured fit dimensions.
- `Fit to Phone` stays disabled until measurement is valid.
- Session screen sends `terminal.resizeForClient`.
- Post-fit resubscribe does not focus/fit the desktop pane before the renderer has processed the override event.
- Success path resubscribes/reinitializes terminal.
- Failure path keeps existing terminal visible.

Manual validation:

1. Open Claude Code in a desktop worktree terminal.
2. Open same terminal on Android.
3. Tap `Fit to Phone`.
4. Confirm Claude Code repaints to phone-sized layout and mobile text is readable without tiny scaling.
5. Confirm desktop terminal shows same phone-sized layout and does not immediately snap back.
6. Resize desktop window/sidebar and confirm fitted terminal stays phone-sized.
7. Tap `Restore Desktop Size` and confirm desktop auto-fit returns.
8. Repeat with SSH-backed terminal.

## Alternatives Considered

### A. Keep Client-Side Scaling Only

This is the current behavior. It is safest for desktop because mobile is read-only with respect to dimensions.

Tradeoff: phone readability remains poor for wide desktop terminals.

### B. Always Resize PTY on Mobile Open

Mobile could resize the PTY automatically whenever a terminal opens.

Tradeoff: surprising desktop side effects. Opening the mobile app would mutate an active desktop session, potentially while the desktop user is working.

### C. Create a Separate Mobile PTY

Mobile could spawn a separate terminal with phone dimensions in the same worktree.

Tradeoff: it does not solve the core use case of continuing the existing agent/TUI session. It creates a new shell, not a mobile view of the current live process.

### D. Raw Resize RPC Without Desktop Override

Mobile calls `pty.resize` through RPC, but desktop auto-fit remains unchanged.

Tradeoff: likely flaky. The next desktop fit pass can resize the PTY back to desktop dimensions, making the mobile action appear broken or transient.

## Open Questions

- Should mobile-fit auto-restore when the mobile session screen unmounts, or should it persist until explicit restore?
- ~~Should multiple mobile clients share one override, or should the latest client win?~~ Resolved: latest writer wins (Section 3).
- What exact mobile font size should define the fit grid?
- ~~Should the desktop indicator live in terminal tab chrome, pane chrome, or a subtle in-terminal overlay?~~ Resolved: dismissible banner in the terminal pane (Section 4).

## Recommendation

Implement explicit mobile-fit mode with runtime-owned PTY resize and desktop auto-fit suppression.

The core reason is architectural: the PTY grid is the source of truth for TUI layout. Mobile can only get a correct phone layout by resizing the real PTY, and desktop must know that the PTY is temporarily controlled by a mobile-sized fit mode so it does not undo the resize.
