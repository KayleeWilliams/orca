/**
 * Foreground-process poller for panes with a live agent-status entry.
 *
 * Why: agent CLIs (Codex, Gemini, OpenCode, ...) don't fire a hook when the
 * user Ctrl+Cs out of them, so the renderer's `agentStatusByPaneKey` entry
 * for an interrupted session lingers until its 30-min TTL decays. Polling
 * `getForegroundProcess(ptyId)` in the main process gives us an authoritative
 * "agent process is gone" signal — independent of terminal-title heuristics.
 *
 * Only transitions from a non-shell foreground process back to a shell fire
 * the drop IPC. Subprocess churn (git, node, rg) within an agent turn is
 * ignored because the foreground was already non-shell when the pane was
 * tracked.
 *
 * Platform fallback: when `getForegroundProcess` returns null or throws
 * (Windows, SSH remotes), the poller emits nothing — the 30-min staleness
 * TTL + renderer's decay-to-idle handles those cases.
 */

const DEFAULT_POLL_INTERVAL_MS = 2_000

// Why: only these basenames count as "shell". Anything else — including
// agents that run as `node` (Claude) — is treated as a live agent session.
// Match cross-platform shells that appear in LocalPtyProvider's getDefaultShell
// paths plus the common Unix interactive shells. Kept intentionally small:
// the detection rule is "foreground is not one of these" rather than
// "foreground is a known agent", so new agent CLIs need no update here.
const SHELL_BASENAMES = new Set(['zsh', 'bash', 'fish', 'pwsh', 'sh', 'cmd.exe', 'powershell.exe'])

function isShellProcess(name: string | null): boolean {
  if (!name) {
    return false
  }
  return SHELL_BASENAMES.has(name.toLowerCase())
}

type EmitShell = (ptyId: string) => void
type GetForegroundProcess = (ptyId: string) => Promise<string | null>

type TrackedPane = {
  ptyId: string
  /** Last observed foreground process classification. Starts at null so the
   *  first poll after `trackPane` does not synthesize a spurious transition
   *  when the foreground is already shell (e.g. the user Ctrl+C'd before the
   *  first poll tick landed). */
  lastWasShell: boolean | null
}

export type AgentForegroundPollerOptions = {
  getForegroundProcess: GetForegroundProcess
  emitShell: EmitShell
  /** Poll interval in ms. Tests override this; production uses the default. */
  intervalMs?: number
}

export type AgentForegroundPoller = {
  /** Track a pane's PTY. Subsequent polls will classify its foreground
   *  process and fire `emitShell(ptyId)` on non-shell→shell transitions.
   *  Idempotent: re-tracking the same paneKey with the same ptyId is a no-op. */
  trackPane(paneKey: string, ptyId: string): void
  /** Stop tracking a pane. Called when a pane's agent-status entry is
   *  removed (renderer-driven) or its PTY exits (main-driven). */
  untrackPane(paneKey: string): void
  /** Exposed for tests — returns the number of panes currently tracked. */
  trackedCount(): number
  /** Exposed for tests — force one poll pass synchronously. */
  pollOnce(): Promise<void>
  /** Stop the timer and clear state. Called on window close / app quit. */
  stop(): void
}

export function createAgentForegroundPoller(
  options: AgentForegroundPollerOptions
): AgentForegroundPoller {
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const tracked = new Map<string, TrackedPane>()
  let timer: ReturnType<typeof setInterval> | null = null
  // Why: poll passes are async, and a paneKey can be untracked mid-pass. Bump
  // this counter on every untrack so an in-flight classification whose paneKey
  // was removed (or re-added with a different ptyId) cannot clobber the map
  // with stale data.
  let epoch = 0

  const ensureTimerRunning = (): void => {
    if (timer !== null) {
      return
    }
    if (tracked.size === 0) {
      return
    }
    timer = setInterval(() => {
      void pollOnce()
    }, intervalMs)
  }

  const stopTimer = (): void => {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  const pollOnce = async (): Promise<void> => {
    // Snapshot the current entries so untrack during await cannot mutate what
    // we iterate. The epoch check below re-validates each entry after the
    // async boundary.
    const entries = Array.from(tracked.entries())
    const epochAtStart = epoch
    for (const [paneKey, entry] of entries) {
      let foreground: string | null = null
      try {
        foreground = await options.getForegroundProcess(entry.ptyId)
      } catch {
        // Why: Windows today and SSH remotes today surface failures as thrown
        // errors or null; in both cases we defer to the renderer's 30-min TTL
        // rather than fire a transition we cannot trust.
        continue
      }
      if (foreground === null) {
        // Same rationale as the catch — treat "unknown" as "do not fire",
        // never as "agent is gone".
        continue
      }
      if (epoch !== epochAtStart) {
        // Untrack happened while our await was in flight. Re-check the map
        // before writing — a stale write here could resurrect a removed entry.
        const current = tracked.get(paneKey)
        if (!current || current.ptyId !== entry.ptyId) {
          continue
        }
      }
      const current = tracked.get(paneKey)
      if (!current || current.ptyId !== entry.ptyId) {
        continue
      }
      const isShell = isShellProcess(foreground)
      const wasShell = current.lastWasShell
      current.lastWasShell = isShell
      // Why: fire exactly on the non-shell→shell edge. The initial poll
      // (wasShell === null) never fires — we only know the transition is a
      // real agent exit when we have seen the foreground as non-shell first.
      if (wasShell === false && isShell) {
        options.emitShell(entry.ptyId)
      }
    }
  }

  return {
    trackPane(paneKey, ptyId) {
      const existing = tracked.get(paneKey)
      if (existing && existing.ptyId === ptyId) {
        return
      }
      tracked.set(paneKey, { ptyId, lastWasShell: null })
      ensureTimerRunning()
    },
    untrackPane(paneKey) {
      if (!tracked.delete(paneKey)) {
        return
      }
      epoch += 1
      if (tracked.size === 0) {
        stopTimer()
      }
    },
    trackedCount() {
      return tracked.size
    },
    pollOnce,
    stop() {
      stopTimer()
      tracked.clear()
      epoch += 1
    }
  }
}

// Exported for tests only.
export const __testing = { SHELL_BASENAMES, isShellProcess }
