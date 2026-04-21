# Browser Automation Review Findings

Last updated: 2026-04-20

## Status legend

- `open`: confirmed issue, not fixed yet
- `fixed`: addressed on this branch
- `not-a-bug`: investigated and verified as expected behavior

## Targeting semantics

- `fixed` `src/cli/index.ts`, `src/cli/index.test.ts`
  Issue: `tab switch --page <id>` was auto-scoped to the current worktree by default.
  Resolution: page-targeted tab switches now match the rest of the `--page` model:
  global by default, with `--worktree` only acting as explicit validation.

- `fixed` `src/main/runtime/orca-runtime.ts:1183`, `src/main/runtime/orca-runtime.test.ts`
  Issue: explicit `--worktree` validation was silently dropped for browser commands because
  `resolveBrowserWorktreeId()` caught resolution failures and fell back to unscoped routing.
  Resolution: explicit selector resolution errors now propagate, while only the follow-up UI
  activation step remains best-effort. Added tests for both page-targeted and non-page browser
  commands.

- `fixed` `src/main/runtime/orca-runtime.ts:2168`, `src/renderer/src/hooks/useIpcEvents.ts`, `src/renderer/src/hooks/useIpcEvents.test.ts`
  Issue: `tab close --worktree <selector>` could close the wrong tab because main fell back to
  renderer-side global active-tab state when it could not resolve a concrete tab id.
  Resolution: the close request now carries `worktreeId`, and the renderer falls back to that
  worktree's active browser workspace instead of the global active browser tab.

- `open` `src/main/runtime/orca-runtime.ts:2153`
  Issue: `tab close --page <id>` trusts the page id directly and does not verify that it exists
  or belongs to the supplied `--worktree`.

- `fixed` `src/main/browser/agent-browser-bridge.ts:247`, `src/renderer/src/store/slices/browser.ts:598`, `src/renderer/src/store/slices/browser.ts:810`, `src/main/ipc/browser.ts:148`, `src/main/ipc/browser.test.ts`
  Issue: per-worktree active-tab routing is not updated when the renderer changes the active
  browser page, so worktree-scoped automation can target a stale page.
  Resolution: `browser:activeTabChanged` now forwards the owning worktree id into the bridge so
  renderer tab switches update both the global active guest and the per-worktree active guest.

## Screenshot behavior

- `fixed` `src/main/browser/agent-browser-bridge.ts:828`, `src/main/browser/agent-browser-bridge.test.ts`
  Issue: `full-screenshot` invoked `agent-browser screenshot --full-page`, but the underlying
  CLI expects `--full`, which surfaced unrelated errors like `Element not found`.
  Resolution: the bridge now uses the documented `--full` flag and has a regression test to keep
  the CLI contract aligned with `agent-browser`.

- `fixed` `src/main/browser/agent-browser-bridge.ts`, `src/main/browser/cdp-screenshot.ts`, `src/main/browser/cdp-screenshot.test.ts`
  Issue: `full-screenshot` could render duplicated quadrants on HiDPI displays because the
  full-page path depended on stitched agent-browser capture behavior and device-pixel layout
  bounds instead of CSS-pixel page geometry.
  Resolution: full-page screenshots now bypass agent-browser's stitched capture path and use
  direct CDP capture with `cssContentSize`-based clip bounds, so the page is captured once at
  its real CSS layout size.

- `fixed` `src/main/browser/browser-manager.ts:126`, `src/renderer/src/components/browser-pane/BrowserPane.tsx:312`, `src/main/browser/browser-manager.test.ts`
  Issue: screenshot visibility prep activates the owning browser workspace, but not the target
  page inside a multi-page workspace.
  Resolution: screenshot prep now switches the active page within the target workspace before
  capture and restores the previously active page afterward when needed.

- `fixed` `src/main/browser/browser-manager.ts:133`, `src/main/browser/browser-manager.ts:218`, `src/main/browser/browser-manager.test.ts`
  Issue: background screenshot prep steals Orca window focus and does not restore it afterward.
  Resolution: screenshot prep no longer forces the host BrowserWindow to the foreground. Guest
  background throttling remains disabled, so capture prep can avoid stealing app focus entirely.

- `fixed` `src/main/browser/cdp-screenshot.ts:68`, `src/main/browser/cdp-bridge.ts:636`, `src/main/browser/cdp-screenshot.test.ts`
  Issue: the screenshot timeout fallback ignores clip/full-page geometry, so a timed-out
  clipped or full-page request can return the wrong image.
  Resolution: the fallback now crops visible-viewport screenshots when possible and refuses
  beyond-viewport requests that `capturePage()` cannot faithfully reproduce.

- `fixed` `src/main/browser/cdp-screenshot.ts:68`, `src/main/browser/cdp-screenshot.test.ts`
  Issue: the timeout fallback does not re-check `settled` after awaiting `capturePage()`, so CDP
  and fallback paths can race to emit results.
  Resolution: the fallback path now re-checks `settled` after `capturePage()` resolves and before
  emitting any result, so only one screenshot path can win.

- `fixed` `src/main/browser/cdp-ws-proxy.ts:29`, `src/main/browser/cdp-ws-proxy.ts:268`, `src/main/browser/cdp-ws-proxy.test.ts`
  Issue: inflight CDP responses are not bound to the websocket that issued them, so reconnects
  can deliver late responses to the wrong client.
  Resolution: command responses are now sent back to the websocket that originated the request,
  so late results from a closed client are dropped instead of leaking into a newer connection.

## Console behavior

- `not-a-bug` `src/main/browser/agent-browser-bridge.ts:1252`, `src/main/browser/cdp-ws-proxy.ts`
  Issue: `console --page` can show Electron/CSP warnings that look like host-app logs.
  Resolution: live verification with per-page `console.log(...)` markers showed that each page id
  only returns its own page-scoped marker plus the same Electron security warning. The warning is
  emitted inside each guest renderer context, so the command is page-scoped even though the output
  includes Chromium/Electron-flavored warnings.

## Session lifecycle and process swaps

- `fixed` `src/main/browser/agent-browser-bridge.ts:264`, `src/main/browser/agent-browser-bridge.ts:1148`, `src/main/browser/agent-browser-bridge.ts:1169`, `src/main/browser/agent-browser-bridge.ts:1559`, `src/main/browser/agent-browser-bridge.test.ts`
  Issue: intercept restore after a process swap replays old intercept patterns after the first
  successful command on the new session, which can re-enable routes the caller just disabled.
  Resolution: explicit `network route` / `network unroute` commands now suppress automatic
  pending-route replay on session re-init and clear any saved restore state after they succeed.

- `fixed` `src/main/browser/agent-browser-bridge.ts:1495`, `src/main/browser/agent-browser-bridge.ts:1590`, `src/main/browser/agent-browser-bridge.test.ts`
  Issue: session teardown rejects queued commands but does not cancel the command already in
  flight, so callers can hang until timeout after a tab closes or swaps renderer.
  Resolution: each session now tracks its active `agent-browser` child process, and destroying
  the session kills that process so the in-flight command fails immediately with a clear error.

- `fixed` `src/main/browser/browser-manager.ts:387`, `src/main/browser/browser-manager.ts:448`, `src/main/browser/browser-manager.test.ts`
  Issue: re-registering a page with a new `webContentsId` leaves the old reverse mapping behind,
  so late events from the dead guest can be misrouted to the live tab.
  Resolution: validated re-registration now retires the old guest id, removes its main-process
  listeners, and drops pending event queues before the new guest mapping becomes active.
