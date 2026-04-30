# Mobile Phone-Fit Debug Status

## Architecture Overview

```
Mobile Client                    Server (orca-runtime)              Desktop Renderer
─────────────                    ────────────────────              ────────────────
subscribeToTerminal(handle)  →   terminal.subscribe handler    →   IPC: terminalFitOverrideChanged
  sends { client, viewport }     calls handleMobileSubscribe()     setFitOverride() → banner render
                                 resizes PTY, sets override
                                 serializes scrollback
                              ←  scrollback { cols, rows,
                                   serialized, displayMode }

switchTab(handle)            →   terminal.unsubscribe (old)
  unsub old, subscribe new       handleMobileUnsubscribe()
                                 starts 300ms restore timer
                             →   terminal.subscribe (new)
                                 handleMobileSubscribe()
                                 cancels timer, inline-restores old
                                 resizes new PTY

toggleDisplayMode(handle)    →   terminal.setDisplayMode
                                 applyMobileDisplayMode()
                             ←   resized event on stream
```

## Key Data Structures (Server)

- `mobileSubscribers: Map<ptyId, { clientId, viewport, wasResizedToPhone, previousCols, previousRows }>`
- `pendingRestoreTimers: Map<ptyId, { timer, clientId }>` (changed from clientId-keyed to ptyId-keyed)
- `terminalFitOverrides: Map<ptyId, { mode, cols, rows, previousCols, previousRows, clientId }>`
- `mobileDisplayModes: Map<ptyId, 'auto' | 'phone' | 'desktop'>`

## Key Data Structures (Mobile Client)

- `viewportRef: { cols, rows } | null` — measured once from xterm, passed with every subscribe
- `viewportMeasuredRef: boolean` — true after first successful measurement
- `terminalUnsubsRef: Map<handle, unsub()>` — active subscription cleanup closures
- `initializedHandlesRef: Set<handle>` — tracks which terminals have been init'd (prevents double-init)
- `subscribeSeqRef: Map<handle, number>` — monotonic counter to ignore stale scrollback

---

## Bug 1: pendingRestoreTimers lost when 2 unsubscribes happen back-to-back

**Status: FIXED (verification inconclusive — may need more testing)**

**Root cause**: `pendingRestoreTimers` was keyed by `clientId` (one slot per device). When two terminals were unsubscribed in quick succession, the second timer overwrote the first.

**Fix applied**:
1. Changed `pendingRestoreTimers` from `Map<clientId, {timer, ptyId}>` to `Map<ptyId, {timer, clientId}>`
2. `handleMobileSubscribe` cancels only the restore timer for the SAME ptyId (re-subscribe case). Other terminals' timers fire normally so their desktop banners clear.
3. `handleMobileSubscribe` skips resize if PTY is already at target phone dims
4. `handleCreateTerminal` now unsubscribes the old active terminal before setting the new one
5. Restore happens via: 300ms timer (tab switch), or `onClientDisconnected` (full disconnect)

**Bug 8 (banners accumulate on tab switch)**: The original Bug 1 fix was too aggressive — it cancelled ALL pending restore timers for the client, not just the one for the ptyId being re-subscribed. This prevented the 300ms restore timer from firing for the old terminal, so its desktop banner persisted. Fixed by narrowing the cancel scope to only the same ptyId.

**Files**: `orca-runtime.ts`, `[worktreeId].tsx`

---

## Bug 2: Intermittent blank terminal on tab switch

**Status: FIX v2 APPLIED — needs testing**

**Symptom**: After creating a new terminal tab, the original 2 terminals occasionally show blank. Leaving the worktree and re-entering fixes it.

**Root cause**: The WebView loads xterm.js from CDN, which takes time. Messages sent before `web-ready` queue in `pendingMessagesRef` and flush when ready. The original `handleTerminalWebReady` would unsub+resub ALL initialized terminals (even inactive ones), creating stale server-side subscriptions and disrupting the data stream.

**Fix v1 (FAILED)**: Gated `subscribeToTerminal` on webReady. This was too aggressive — it prevented subscriptions entirely, so no scrollback arrived, no init was queued, and the terminal stayed blank.

**Fix v2 (current)**:
1. `subscribeToTerminal` has NO webReady guard — subscriptions start immediately, init messages queue in `pendingMessagesRef`, and flush when `web-ready` fires
2. `handleTerminalWebReady` distinguishes first load vs reload:
   - **First load** (`wasAlreadyReady=false`): just marks webReady, triggers viewport measurement for active terminal. Pending messages flush after this callback returns → terminal renders.
   - **Reload** (`wasAlreadyReady=true`): unsubscribes and resubscribes to get fresh scrollback (old xterm buffer is gone). Only resubscribes if active.
3. `setTerminalWebViewRef` simplified to just store the ref (no subscription logic)

**Flow (first load)**:
1. `fetchTerminals` → `subscribeToTerminal(active)` → stream starts
2. Scrollback arrives → `init()` queued in pendingMessages (WebView not ready yet)
3. WebView loads xterm from CDN → `web-ready` fires
4. `handleTerminalWebReady`: marks webReady, triggers viewport measurement (async)
5. `flushPendingMessages()`: sends queued init → terminal renders
6. Viewport measured → resubscribe with dims → server phone-fits → reinit with phone dims

---

## Bug 5: Desktop banner not showing for initial split pane after creating new tab

**Status: FIXED (verified via CDP + e2e testing)**

**Root cause**: The bug was caused by the inline restore mechanism in `handleMobileSubscribe`. When mobile switched tabs, the server would restore the previous terminal to desktop dims (sending `desktop-fit` IPC), which cleared the override from `overridesByPtyId`. After the next subscribe, the override was re-set via `mobile-fit` IPC, but the timing was tight and the banner could flicker or fail to appear.

**Fix**: Removed inline restore from `handleMobileSubscribe` (Bug 1 fix). PTYs now stay at phone dims when the mobile client switches tabs. Overrides persist in `overridesByPtyId` until the mobile client disconnects. This means ALL terminals the mobile client has subscribed to show the banner — which is correct since the mobile client "owns" those terminals.

**Verification**: E2e testing via CDP (desktop renderer) and agent-device (mobile) confirmed:
- `setFitOverride()` is called correctly via IPC
- `onOverrideChange` fires and triggers re-renders
- `getFitOverrideForPane()` finds overrides when `ptyIdByPaneId` bindings exist
- Banners show correctly for all terminals (1, 2, and 3 tabs) including after creating new tabs
- The earlier diagnostic showed HMR clearing module-level maps was a test artifact, not a production issue

---

## Bug 7: Terminals disappear ("0 terminals") during rapid tab switching

**Status: FIXED (verified via e2e testing)**

**Symptom**: During rapid tab switching (3+ toggles in quick succession), all terminals disappear from the mobile UI. The terminal list shows "0 terminals". Leaving the worktree and re-entering fixes it.

**Root cause**: The periodic `fetchTerminals()` (every 2s) calls with `allowEmptyLoaded: true`. The server can transiently return an empty terminal list during rapid operations. The old code's subscription cleanup loop (`liveHandles` check) ran before the empty guard, unsubscribing all terminals, which then made the empty guard's `terminalUnsubsRef.current.size > 0` check fail.

**Fix applied**:
1. Added `lastKnownTerminalCountRef` to track the previous non-zero terminal count
2. When the server returns 0 terminals but `lastKnownTerminalCountRef > 0`, skip the FIRST empty response (set ref to 0 and return early)
3. On the NEXT fetch, if still empty, `lastKnownTerminalCountRef` is 0, so the guard doesn't trigger and terminals are cleared normally
4. This gives a ~2s grace period (one polling interval) to filter out transient empty responses
5. The guard runs BEFORE the subscription cleanup loop, preventing premature unsubscription

**Verification**: Rapid tab switching (8 cycles across 3 terminals in ~1.6s) with 20s wait — terminals survived. Previous code cleared to "0 terminals" within 18s.

**Files**: `[worktreeId].tsx`

---

## Bug 3: Viewport measurement chicken-and-egg

**Status: SOLVED (workaround in place)**

The first subscribe has `viewport=none`. After scrollback init, async measure viewport, resubscribe with dims. Takes 2-3 round-trips. Works reliably.

---

## Bug 4: Desktop terminal focus doesn't follow mobile tab switching

**Status: FIXED**

`switchTab` now calls `terminal.focus` RPC.

---

## Bug 6: Claude not launching on new workspace

**Status: FIXED**

**Root cause**: Mobile's `NewWorktreeModal` sends `startupCommand` (e.g. `'claude'`) in the `worktree.create` RPC call, but the Zod schema (`WorktreeCreate`) did not include `startupCommand`, so it was silently stripped during validation. The runtime's `createManagedWorktree` never received the startup command, so `args.startup` was always undefined and the activation IPC never included a startup payload. The left pane spawned a plain shell instead of the selected agent.

**Fix applied**:
1. Added `startupCommand: OptionalString` to the `WorktreeCreate` Zod schema in `src/main/runtime/rpc/methods/worktree.ts`
2. RPC handler maps `params.startupCommand` → `{ command }` and passes to `runtime.createManagedWorktree()`
3. Added `startup?: WorktreeStartupLaunch` to `createManagedWorktree`'s args type in `orca-runtime.ts`

**Bug 6b: `waitForLeafPtyId` times out due to handle invalidation**

When a leaf's ptyId changes from null to a real value, `syncWindowGraph` invalidates the old handle (deletes it from `this.handles`). The `waitForLeafPtyId` callback calls `resolveLeafForHandle(handle)` which returns null because the handle no longer exists. The wait never resolves.

**Fix**: `waitForLeafPtyId` now captures the handle's `tabId` and `leafId` before the handle can be invalidated. The callback falls back to direct `this.leaves.get(getLeafKey(tabId, leafId))` lookup when the handle-based lookup fails.

**Files**: `src/main/runtime/rpc/methods/worktree.ts`, `src/main/runtime/orca-runtime.ts`

---

## Diagnostic Logging

All logs prefixed with `[mobile-fit]`.

### Server-side (main process stdout)
| Location | What it logs |
|----------|-------------|
| `terminal.subscribe` handler | handle, ptyId, client type, viewport |
| `handleMobileSubscribe` | ptyId, mode, viewport, skip reasons, resize details |
| `handleMobileUnsubscribe` | ptyId, subscriber state, wasResized |
| `applyMobileDisplayMode` | ptyId, mode, subscriber state |

### Mobile client (React Native console)
| Location | What it logs |
|----------|-------------|
| `subscribeToTerminal` | handle, seq, viewport, measured state |
| scrollback handler | cols, rows, displayMode, hasSerialized, alreadyInit |
| resized handler | cols, rows, displayMode, reason |
| `switchTab` | prev/next handle, hasUnsub, hasRef |
| `toggleDisplayMode` | handle, current mode, next mode |
| `setTerminalWebViewRef` | handle, isActive, activeHandle |

### Desktop renderer (DevTools console)
| Location | What it logs |
|----------|-------------|
| `useIpcEvents.ts` | fitOverrideChanged IPC events received |
| `TerminalPane.tsx` | onOverrideChange callbacks fired |

---

## Priority Order

1. ~~**Bug 2 (blank terminal)**~~ — **FIXED**. WebView readiness lifecycle corrected.
2. ~~**Duplicate prompt lines**~~ — **FIXED**. Removed inline restore, added alreadyAtTarget skip.
3. ~~**Bug 7 (0 terminals)**~~ — **FIXED**. Consecutive-empty guard with `lastKnownTerminalCountRef`.
4. ~~**Bug 5 (banner missing)**~~ — **FIXED**. Side effect of inline restore removal + verified via CDP.
5. ~~**Bug 1 (timer overwrite)**~~ — **FIXED**. `pendingRestoreTimers` keyed by ptyId, cancel without restore.
6. **Cleanup** — Remove `[mobile-fit]` diagnostic logs, Debug Test button, dead code.
