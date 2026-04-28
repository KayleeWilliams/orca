import { execFileSync } from 'node:child_process'
import { app, ipcMain } from 'electron'
import { isWslAvailable } from '../wsl'

export type AppRuntimeFlags = {
  /** Whether the persistent terminal daemon was actually started this session.
   *  The renderer compares this against the current setting to decide whether
   *  a "restart required" banner needs to be shown on the Experimental pane. */
  daemonEnabledAtStartup: boolean
}

export type DaemonTransitionNotice = {
  /** Number of live daemon PTY sessions that were killed when the app booted
   *  with `experimentalTerminalDaemon: false` but discovered a leftover daemon
   *  from a previous session. Non-zero values are surfaced in a one-shot
   *  toast so the user knows background work was stopped. */
  killedCount: number
}

let runtimeFlags: AppRuntimeFlags = { daemonEnabledAtStartup: false }
let pendingDaemonTransitionNotice: DaemonTransitionNotice | null = null

export function setAppRuntimeFlags(flags: AppRuntimeFlags): void {
  runtimeFlags = flags
}

export function recordPendingDaemonTransitionNotice(notice: DaemonTransitionNotice): void {
  pendingDaemonTransitionNotice = notice
}

export function registerAppHandlers(): void {
  ipcMain.handle('app:getRuntimeFlags', (): AppRuntimeFlags => runtimeFlags)

  ipcMain.handle('app:consumeDaemonTransitionNotice', (): DaemonTransitionNotice | null => {
    // Why: one-shot consumption — clear after reading so the renderer's
    // post-hydration effect can't fire the same toast twice (e.g. after a
    // window reload during dev). The persisted `experimentalTerminalDaemonNoticeShown`
    // flag is the cross-session guard; this clear handles within-session races.
    const notice = pendingDaemonTransitionNotice
    pendingDaemonTransitionNotice = null
    return notice
  })

  ipcMain.handle('wsl:isAvailable', (): boolean => isWslAvailable())

  // Why: ABC, Polish Pro, US Extended, ABC Extended, and every CJK Roman
  // IME all report a US-QWERTY base layer to navigator.keyboard.getLayoutMap()
  // — the layout-fingerprint probe in the renderer therefore classifies
  // them as 'us' and flips macOptionIsMeta=true, silently swallowing every
  // Option+letter composition (#1205: Option+A → å / ą is dropped). The
  // macOS-shipped `com.apple.HIToolbox` preference
  // `AppleCurrentKeyboardLayoutInputSourceID` names the actual layout
  // (e.g. `com.apple.keylayout.ABC` vs `com.apple.keylayout.US`), which
  // the renderer uses as an authoritative override. Non-Darwin platforms
  // have no equivalent and return null so the fingerprint stays the only
  // signal.
  //
  // Why `defaults read` (via execFileSync) and not systemPreferences
  // .getUserDefault: getUserDefault only reads from NSGlobalDomain and the
  // current app's own domain. The keyboard layout ID lives in the
  // `com.apple.HIToolbox` domain, which getUserDefault cannot reach —
  // observed to return null even when the preference is set. The `defaults`
  // CLI reads any domain and is the same mechanism Apple documents for
  // this value.
  ipcMain.handle('app:getKeyboardInputSourceId', (): string | null => {
    if (process.platform !== 'darwin') {
      return null
    }
    try {
      const stdout = execFileSync(
        '/usr/bin/defaults',
        ['read', 'com.apple.HIToolbox', 'AppleCurrentKeyboardLayoutInputSourceID'],
        // Why: short timeout so a wedged defaults binary (corporate-managed
        // config, sandbox policy, …) never stalls the renderer's probe.
        // Fall through to the fingerprint on timeout.
        { encoding: 'utf8', timeout: 500, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim()
      return stdout.length > 0 ? stdout : null
    } catch {
      // Why: defaults exits non-zero when the key is absent (first boot
      // before any input-source interaction), or when sandboxed. Treat
      // that as "no signal" — the fingerprint still runs as fallback.
      return null
    }
  })

  ipcMain.handle('app:relaunch', () => {
    // Why: small delay lets the renderer finish painting any "Restarting…"
    // UI state before the window tears down. `app.relaunch()` schedules a
    // spawn; `app.exit(0)` triggers the actual quit without invoking
    // before-quit handlers that could block on confirmation dialogs.
    setTimeout(() => {
      app.relaunch()
      app.exit(0)
    }, 150)
  })
}
