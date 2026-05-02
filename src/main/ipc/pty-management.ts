import { ipcMain } from 'electron'
import { DaemonPtyRouter } from '../daemon/daemon-pty-router'
import type { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'
import { getDaemonProvider, restartDaemon } from '../daemon/daemon-init'
import type { DaemonSessionInfo } from '../daemon/types'

// Why: bounds the listSessions retry loop inside killAll. Three passes is
// enough to catch the normal "SIGTERM→SIGKILL→reap" ladder for a session that
// doesn't exit on the first shutdown RPC; beyond that we stop retrying and
// surface remainingCount so the user can see that some sessions refused to die
// rather than blocking on a tight loop forever.
const MAX_KILL_ALL_RETRIES = 3

function getDaemonAdapters(): DaemonPtyAdapter[] {
  const provider = getDaemonProvider()
  if (!provider) {
    return []
  }
  if (provider instanceof DaemonPtyRouter) {
    return [...provider.getAllAdapters()]
  }
  return [provider]
}

async function collectSessions(adapters: DaemonPtyAdapter[]): Promise<DaemonSessionInfo[]> {
  const results = await Promise.allSettled(
    adapters.map(async (adapter) => {
      const sessions = await adapter.listSessions()
      return sessions.map<DaemonSessionInfo>((s) => ({
        ...s,
        protocolVersion: adapter.protocolVersion
      }))
    })
  )
  return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
}

export function registerDaemonManagementHandlers(): void {
  ipcMain.removeHandler('pty:management:listSessions')
  ipcMain.removeHandler('pty:management:killAll')
  ipcMain.removeHandler('pty:management:killOne')
  ipcMain.removeHandler('pty:management:restart')

  ipcMain.handle(
    'pty:management:listSessions',
    async (): Promise<{ sessions: DaemonSessionInfo[] }> => {
      const sessions = await collectSessions(getDaemonAdapters())
      return { sessions }
    }
  )

  // Why: killAll operates on *sessions* (user-facing concept), not daemons, so
  // it fans across every adapter — current + legacy — to match the user's
  // "kill everything I might be attached to" mental model. The daemon
  // processes themselves survive; only sessions are torn down. See
  // docs/daemon-staleness-ux.md §Phase 1 "Scope rationale" for why legacy
  // daemons aren't killed here.
  ipcMain.handle(
    'pty:management:killAll',
    async (): Promise<{ killedCount: number; remainingCount: number }> => {
      const adapters = getDaemonAdapters()
      const initial = await collectSessions(adapters)
      const initialCount = initial.length

      for (let attempt = 0; attempt < MAX_KILL_ALL_RETRIES; attempt += 1) {
        const sessions = await collectSessions(adapters)
        if (sessions.length === 0) {
          break
        }
        await Promise.allSettled(
          sessions.map(async (session) => {
            // Why: protocolVersion is unique across adapters by construction
            // — PROTOCOL_VERSION is always distinct from every entry in
            // PREVIOUS_DAEMON_PROTOCOL_VERSIONS (see types.ts). If a future
            // bump forgets to rotate the retired version into the previous
            // list, this find() would silently route legacy sessions to the
            // current adapter. Keep the two constants in lockstep.
            const owner = adapters.find((a) => a.protocolVersion === session.protocolVersion)
            if (!owner) {
              return
            }
            // Why: immediate=true forwards SIGKILL once the daemon's SIGTERM
            // grace window elapses, matching the "kill it now" intent of the
            // button. Failures are swallowed per-session so one stuck session
            // can't poison the whole batch — remainingCount surfaces them in
            // the toast.
            await owner.shutdown(session.sessionId, true).catch(() => {})
          })
        )
      }

      const remaining = await collectSessions(adapters)
      const remainingCount = remaining.length
      const killedCount = Math.max(0, initialCount - remainingCount)
      return { killedCount, remainingCount }
    }
  )

  ipcMain.handle(
    'pty:management:killOne',
    async (_event, args: { sessionId: string }): Promise<{ success: boolean }> => {
      if (typeof args?.sessionId !== 'string' || args.sessionId.length === 0) {
        return { success: false }
      }
      const adapters = getDaemonAdapters()
      const sessions = await collectSessions(adapters)
      const match = sessions.find((s) => s.sessionId === args.sessionId)
      if (!match) {
        return { success: false }
      }
      const owner = adapters.find((a) => a.protocolVersion === match.protocolVersion)
      if (!owner) {
        return { success: false }
      }
      try {
        await owner.shutdown(args.sessionId, true)
        return { success: true }
      } catch {
        return { success: false }
      }
    }
  )

  ipcMain.handle('pty:management:restart', async (): Promise<{ success: boolean }> => {
    try {
      await restartDaemon()
      return { success: true }
    } catch (err) {
      console.error('[pty:management] restart failed', err)
      return { success: false }
    }
  })
}
