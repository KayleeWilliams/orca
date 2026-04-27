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
 * (Windows, SSH remotes, or daemon-backed PTYs running an older daemon
 * protocol that predates the getForegroundProcess RPC), the poller emits
 * nothing — the 30-min staleness TTL + renderer's decay-to-idle handles
 * those cases.
 */

const DEFAULT_POLL_INTERVAL_MS = 2_000

// Why: only these basenames count as "shell". Anything else — including
// agents that run as `node` (Claude) — is treated as a live agent session.
// Match cross-platform shells that appear in LocalPtyProvider's getDefaultShell
// paths plus the common Unix interactive shells. Kept intentionally small:
// the detection rule is "foreground is not one of these" rather than
// "foreground is a known agent", so new agent CLIs need no update here.
const SHELL_BASENAMES = new Set([
  'zsh',
  'bash',
  'fish',
  'pwsh',
  'sh',
  'cmd.exe',
  'pwsh.exe',
  'powershell.exe'
])

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

  // Why: once-per-pane rate limit for swallowed getForegroundProcess errors.
  // We want a breadcrumb (real provider regressions shouldn't be invisible)
  // but not log spam on a persistently-failing provider (e.g. SSH remote or
  // Windows pre-fallback). Cleared on untrack/stop so a re-tracked pane gets
  // a fresh chance to log.
  const loggedErrorPaneKeys = new Set<string>()

  // Why: re-entry guard. A slow getForegroundProcess call (or many tracked
  // panes) must not let setInterval fire a second pass while the first is
  // still in flight: overlapping passes can double-fire emitShell on the
  // same non-shell→shell edge or interleave writes to lastWasShell.
  let isPolling = false

  const pollOnce = async (): Promise<void> => {
    if (isPolling) {
      return
    }
    isPolling = true
    try {
      // Snapshot the current entries so untrack during await cannot mutate
      // what we iterate. The per-entry `tracked.get(paneKey)` re-check below
      // re-validates each entry after the async boundary.
      const entries = Array.from(tracked.entries())
      // Pane-lookup parallelism is safe because each async task keys on a
      // distinct paneKey, and writes to tracked.get(paneKey).lastWasShell
      // touch only that pane's entry.
      await Promise.all(
        entries.map(async ([paneKey, entry]) => {
          let foreground: string | null = null
          try {
            foreground = await options.getForegroundProcess(entry.ptyId)
          } catch (error) {
            // Why: Windows today and SSH remotes today surface failures as
            // thrown errors or null; in both cases we defer to the renderer's
            // 30-min TTL rather than fire a transition we cannot trust.
            if (!loggedErrorPaneKeys.has(paneKey)) {
              loggedErrorPaneKeys.add(paneKey)
              console.warn(
                '[agent-foreground-poller] getForegroundProcess failed for pane',
                paneKey,
                error
              )
            }
            return
          }
          if (foreground === null || foreground === '') {
            // Why: treat "unknown" (null or empty string from providers that don't
            // coalesce missing process info to null) as "do not fire" — never as
            // "agent is gone". Firing on an empty foreground would prime a false
            // non-shell→shell edge on the next real shell observation.
            return
          }
          const current = tracked.get(paneKey)
          if (!current || current.ptyId !== entry.ptyId) {
            // Untrack (or re-track with a different ptyId) happened while our
            // await was in flight — a stale write here could resurrect a
            // removed entry or clobber a freshly-tracked one.
            return
          }
          const isShell = isShellProcess(foreground)
          const wasShell = current.lastWasShell
          current.lastWasShell = isShell
          // Why: fire exactly on the non-shell→shell edge. The initial poll
          // (wasShell === null) never fires — we only know the transition is
          // a real agent exit when we have seen the foreground as non-shell
          // first.
          if (wasShell === false && isShell) {
            options.emitShell(entry.ptyId)
          }
        })
      )
    } finally {
      isPolling = false
    }
  }

  return {
    trackPane(paneKey, ptyId) {
      const existing = tracked.get(paneKey)
      if (existing && existing.ptyId === ptyId) {
        return
      }
      // Why: a re-track with a different ptyId represents a fresh PTY on the
      // same pane — the new process deserves its own chance to log a one-time
      // provider error. Leaving the previous entry in `loggedErrorPaneKeys`
      // would permanently suppress errors for the replacement PTY.
      loggedErrorPaneKeys.delete(paneKey)
      tracked.set(paneKey, { ptyId, lastWasShell: null })
      ensureTimerRunning()
    },
    untrackPane(paneKey) {
      if (!tracked.delete(paneKey)) {
        return
      }
      loggedErrorPaneKeys.delete(paneKey)
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
      loggedErrorPaneKeys.clear()
    }
  }
}
