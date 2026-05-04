import type { WebContents } from 'electron'

const MAIN_CONSUMED_SHORTCUT_CHANNEL = 'ui:shortcutConsumed'

/**
 * Notify the renderer that main is forwarding a shortcut-action IPC so the
 * renderer's `useModifierHint` hook can clear any pending number-badge state.
 *
 * Fires whenever main dispatches a shortcut-action IPC to the renderer:
 * - an intercepted platform-modifier chord (`before-input-event` +
 *   `preventDefault()`), OR
 * - any menu-item activation that calls `emitConsumedShortcut` in its click
 *   handler — this covers both keyboard accelerators AND mouse clicks on the
 *   same menu item, because click handlers don't distinguish the two. The
 *   renderer's clear is idempotent (no-op when no hint is visible), so
 *   spurious emits from mouse-triggered menu clicks are harmless.
 *
 * Why this exists: when main intercepts a Cmd-chord, the non-modifier key's
 * keydown never reaches the renderer's window-level listener, so the hook's
 * "any other key while modifier held → clear" branch is skipped. On macOS
 * the subsequent Cmd keyup is also frequently dropped after a
 * preventDefault'd chord, so `onKeyUp`-based clearing is unreliable too.
 * A single authoritative signal from main is the stable fix; individual IPC
 * handlers in the renderer then do not need to remember to dispatch a clear.
 *
 * Ordering: callers MUST invoke this BEFORE sending the action IPC so the
 * renderer clears the hint before the action handler runs. This relies on
 * FIFO delivery on the IPC pipe between main and the renderer (ordering
 * preserved across channels for a single WebContents).
 */
export function emitConsumedShortcut(webContents: WebContents | undefined): void {
  webContents?.send(MAIN_CONSUMED_SHORTCUT_CHANNEL)
}
