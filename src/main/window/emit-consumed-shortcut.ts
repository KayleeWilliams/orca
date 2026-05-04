import type { WebContents } from 'electron'

export const MAIN_CONSUMED_SHORTCUT_CHANNEL = 'ui:shortcutConsumed'

/**
 * Notify the renderer that main just consumed a platform-modifier chord
 * (Cmd/Ctrl+X) via `before-input-event` `preventDefault()` or a native menu
 * accelerator. Sent alongside any forwarded action IPC so the renderer's
 * `useModifierHint` hook can clear pending number-badge state.
 *
 * Why this exists: when main intercepts a Cmd-chord, the non-modifier key's
 * keydown never reaches the renderer's window-level listener, so the hook's
 * "any other key while modifier held → clear" branch is skipped. On macOS
 * the subsequent Cmd keyup is also frequently dropped after a
 * preventDefault'd chord, so `onKeyUp`-based clearing is unreliable too.
 * A single authoritative signal from main is the stable fix; individual IPC
 * handlers in the renderer then do not need to remember to dispatch a clear.
 */
export function emitConsumedShortcut(webContents: WebContents | undefined): void {
  webContents?.send(MAIN_CONSUMED_SHORTCUT_CHANNEL)
}
