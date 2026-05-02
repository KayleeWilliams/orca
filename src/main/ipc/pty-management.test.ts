/* eslint-disable max-lines -- Why: covers every pty:management IPC channel
against shared mocks (electron, fs, daemon-init, DaemonPtyRouter). Splitting
across files would duplicate the vi.hoisted setup and the shared helpers,
with no meaningful ownership seam. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonSessionInfo } from '../daemon/types'

const { handleMock, removeHandlerMock, getDaemonProviderMock, restartDaemonMock } = vi.hoisted(
  () => ({
    handleMock: vi.fn(),
    removeHandlerMock: vi.fn(),
    getDaemonProviderMock: vi.fn(),
    restartDaemonMock: vi.fn()
  })
)

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock }
}))

vi.mock('../daemon/daemon-init', () => ({
  getDaemonProvider: getDaemonProviderMock,
  restartDaemon: restartDaemonMock
}))

// Why: the handler uses `provider instanceof DaemonPtyRouter` to branch
// between "plain adapter" and "router with current + legacy adapters".
// Mock the class here so tests can construct real instances via `new
// DaemonPtyRouter(...)` and the instanceof check returns true. The real
// router's constructor is side-effect heavy (subscribes to adapter events),
// so we only keep the accessors that pty-management touches — enough to
// satisfy the runtime type check without pulling in all the wiring.
vi.mock('../daemon/daemon-pty-router', () => {
  class DaemonPtyRouter {
    private allAdapters: unknown[]
    constructor(opts: { current: unknown; legacy: unknown[] }) {
      this.allAdapters = [opts.current, ...opts.legacy]
    }
    getAllAdapters() {
      return this.allAdapters
    }
  }
  return { DaemonPtyRouter }
})

type HandlerMap = Record<string, (event: unknown, args?: unknown) => unknown>

function buildHandlerMap(): HandlerMap {
  const map: HandlerMap = {}
  for (const call of handleMock.mock.calls) {
    const [channel, handler] = call as [string, (event: unknown, args?: unknown) => unknown]
    map[channel] = handler
  }
  return map
}

function makeSession(
  sessionId: string,
  overrides: Partial<DaemonSessionInfo> = {}
): DaemonSessionInfo {
  return {
    sessionId,
    state: 'running',
    shellState: 'ready',
    isAlive: true,
    pid: 1234,
    cwd: '/home/user',
    cols: 80,
    rows: 24,
    createdAt: 0,
    protocolVersion: 4,
    ...overrides
  }
}

type MockAdapter = {
  protocolVersion: number
  listSessions: ReturnType<typeof vi.fn>
  shutdown: ReturnType<typeof vi.fn>
}

function makeAdapter(
  protocolVersion: number,
  sessions: DaemonSessionInfo[],
  shutdownImpl?: (id: string, immediate: boolean) => Promise<void>
): MockAdapter {
  // Why: collectSessions calls adapter.listSessions() (the daemon-side RPC)
  // and then annotates with adapter.protocolVersion. The mock returns the
  // *internal* SessionInfo shape (no protocolVersion) since the adapter adds
  // it. Stripping it here mirrors production behavior.
  return {
    protocolVersion,
    listSessions: vi.fn(async () => sessions.map(({ protocolVersion: _pv, ...rest }) => rest)),
    shutdown: vi.fn(shutdownImpl ?? (async () => {}))
  }
}

async function importFresh() {
  vi.resetModules()
  handleMock.mockClear()
  removeHandlerMock.mockClear()
  return import('./pty-management')
}

async function makeRouter(current: MockAdapter, legacy: MockAdapter[] = []) {
  const { DaemonPtyRouter } = await import('../daemon/daemon-pty-router')
  return new DaemonPtyRouter({ current: current as never, legacy: legacy as never })
}

describe('pty:management IPC handlers', () => {
  beforeEach(() => {
    getDaemonProviderMock.mockReset()
    restartDaemonMock.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('listSessions', () => {
    it('merges sessions across current + legacy adapters with protocolVersion', async () => {
      const current = makeAdapter(4, [makeSession('new-1'), makeSession('new-2')])
      const legacy = makeAdapter(3, [makeSession('old-1', { protocolVersion: 3 })])
      const { registerDaemonManagementHandlers } = await importFresh()
      getDaemonProviderMock.mockReturnValue(await makeRouter(current, [legacy]))
      registerDaemonManagementHandlers()

      const handlers = buildHandlerMap()
      const result = (await handlers['pty:management:listSessions']({})) as {
        sessions: DaemonSessionInfo[]
      }

      expect(result.sessions).toHaveLength(3)
      const byId = new Map(result.sessions.map((s) => [s.sessionId, s]))
      expect(byId.get('new-1')?.protocolVersion).toBe(4)
      expect(byId.get('new-2')?.protocolVersion).toBe(4)
      expect(byId.get('old-1')?.protocolVersion).toBe(3)
    })

    it('returns empty list when no daemon provider is installed', async () => {
      getDaemonProviderMock.mockReturnValue(null)

      const { registerDaemonManagementHandlers } = await importFresh()
      registerDaemonManagementHandlers()

      const handlers = buildHandlerMap()
      const result = (await handlers['pty:management:listSessions']({})) as {
        sessions: DaemonSessionInfo[]
      }

      expect(result.sessions).toEqual([])
    })

    it('tolerates a failing adapter by skipping its sessions', async () => {
      const current = makeAdapter(4, [makeSession('new-1')])
      const legacy = makeAdapter(3, [])
      legacy.listSessions = vi.fn(async () => {
        throw new Error('legacy socket dead')
      })
      const { registerDaemonManagementHandlers } = await importFresh()
      getDaemonProviderMock.mockReturnValue(await makeRouter(current, [legacy]))
      registerDaemonManagementHandlers()

      const handlers = buildHandlerMap()
      const result = (await handlers['pty:management:listSessions']({})) as {
        sessions: DaemonSessionInfo[]
      }

      expect(result.sessions).toHaveLength(1)
      expect(result.sessions[0].sessionId).toBe('new-1')
    })
  })

  describe('killAll', () => {
    it('shuts down every session across adapters and reports counts', async () => {
      const current = makeAdapter(4, [makeSession('new-1'), makeSession('new-2')])
      const legacy = makeAdapter(3, [makeSession('old-1', { protocolVersion: 3 })])
      // Each shutdown removes the session from the adapter's backing list so
      // the retry loop observes convergence on the next listSessions() call.
      const removeFrom = (list: DaemonSessionInfo[], id: string): void => {
        const idx = list.findIndex((s) => s.sessionId === id)
        if (idx !== -1) {
          list.splice(idx, 1)
        }
      }
      const currentSessions = [makeSession('new-1'), makeSession('new-2')]
      const legacySessions = [makeSession('old-1', { protocolVersion: 3 })]
      current.listSessions = vi.fn(async () =>
        currentSessions.map(({ protocolVersion: _pv, ...rest }) => rest)
      )
      legacy.listSessions = vi.fn(async () =>
        legacySessions.map(({ protocolVersion: _pv, ...rest }) => rest)
      )
      current.shutdown = vi.fn(async (id: string) => {
        removeFrom(currentSessions, id)
      })
      legacy.shutdown = vi.fn(async (id: string) => {
        removeFrom(legacySessions, id)
      })
      const { registerDaemonManagementHandlers } = await importFresh()
      getDaemonProviderMock.mockReturnValue(await makeRouter(current, [legacy]))
      registerDaemonManagementHandlers()

      const handlers = buildHandlerMap()
      const result = (await handlers['pty:management:killAll']({})) as {
        killedCount: number
        remainingCount: number
      }

      expect(result).toEqual({ killedCount: 3, remainingCount: 0 })
      expect(current.shutdown).toHaveBeenCalledWith('new-1', true)
      expect(current.shutdown).toHaveBeenCalledWith('new-2', true)
      expect(legacy.shutdown).toHaveBeenCalledWith('old-1', true)
    })

    it('reports remainingCount when sessions refuse to die after max retries', async () => {
      const sessions = [makeSession('stuck')]
      const current = makeAdapter(4, [])
      current.listSessions = vi.fn(async () =>
        sessions.map(({ protocolVersion: _pv, ...rest }) => rest)
      )
      // Shutdown silently fails to remove the session — simulates a daemon
      // that accepted the RPC but the underlying process ignored SIGKILL.
      current.shutdown = vi.fn(async () => {})
      const { registerDaemonManagementHandlers } = await importFresh()
      getDaemonProviderMock.mockReturnValue(await makeRouter(current))
      registerDaemonManagementHandlers()

      const handlers = buildHandlerMap()
      const result = (await handlers['pty:management:killAll']({})) as {
        killedCount: number
        remainingCount: number
      }

      expect(result).toEqual({ killedCount: 0, remainingCount: 1 })
      // Retries until MAX_KILL_ALL_RETRIES. The handler calls listSessions
      // once for the initial count and once per retry attempt.
      expect(current.shutdown).toHaveBeenCalledTimes(3)
    })

    it('swallows per-session shutdown errors without blocking the batch', async () => {
      const sessions = [makeSession('a'), makeSession('b')]
      const live = sessions.map(({ protocolVersion: _pv, ...r }) => r)
      const current = makeAdapter(4, [])
      // Why: the handler calls listSessions for (1) the initial count, (2) the
      // retry-loop iteration that drives shutdown, then again after the
      // shutdowns land to recompute remainingCount. Returning `live` until
      // shutdowns remove entries — and [] after — mirrors a daemon that
      // actually reaped the processes.
      let shutdowns = 0
      current.listSessions = vi.fn(async () => (shutdowns >= 2 ? [] : live))
      current.shutdown = vi.fn(async (id: string) => {
        shutdowns += 1
        if (id === 'a') {
          throw new Error('a is stuck')
        }
      })
      const { registerDaemonManagementHandlers } = await importFresh()
      getDaemonProviderMock.mockReturnValue(await makeRouter(current))
      registerDaemonManagementHandlers()

      const handlers = buildHandlerMap()
      const result = (await handlers['pty:management:killAll']({})) as {
        killedCount: number
        remainingCount: number
      }

      // Both shutdowns were attempted; second call to listSessions returned
      // empty so remainingCount settles at 0.
      expect(current.shutdown).toHaveBeenCalledWith('a', true)
      expect(current.shutdown).toHaveBeenCalledWith('b', true)
      expect(result.remainingCount).toBe(0)
    })
  })

  describe('killOne', () => {
    it('routes to the adapter whose protocolVersion owns the session', async () => {
      const current = makeAdapter(4, [makeSession('new-1')])
      const legacy = makeAdapter(3, [makeSession('old-1', { protocolVersion: 3 })])
      const { registerDaemonManagementHandlers } = await importFresh()
      getDaemonProviderMock.mockReturnValue(await makeRouter(current, [legacy]))
      registerDaemonManagementHandlers()

      const handlers = buildHandlerMap()
      const result = (await handlers['pty:management:killOne']({}, { sessionId: 'old-1' })) as {
        success: boolean
      }

      expect(result.success).toBe(true)
      expect(legacy.shutdown).toHaveBeenCalledWith('old-1', true)
      expect(current.shutdown).not.toHaveBeenCalled()
    })

    it('returns success=false for unknown sessionId', async () => {
      const current = makeAdapter(4, [makeSession('new-1')])
      const { registerDaemonManagementHandlers } = await importFresh()
      getDaemonProviderMock.mockReturnValue(await makeRouter(current))
      registerDaemonManagementHandlers()

      const handlers = buildHandlerMap()
      const result = (await handlers['pty:management:killOne']({}, { sessionId: 'ghost' })) as {
        success: boolean
      }

      expect(result.success).toBe(false)
      expect(current.shutdown).not.toHaveBeenCalled()
    })

    it('rejects empty/missing sessionId without hitting the adapter', async () => {
      const current = makeAdapter(4, [makeSession('new-1')])
      const { registerDaemonManagementHandlers } = await importFresh()
      getDaemonProviderMock.mockReturnValue(await makeRouter(current))
      registerDaemonManagementHandlers()

      const handlers = buildHandlerMap()
      const result = (await handlers['pty:management:killOne']({}, { sessionId: '' })) as {
        success: boolean
      }

      expect(result.success).toBe(false)
      expect(current.listSessions).not.toHaveBeenCalled()
    })
  })

  describe('restart', () => {
    it('delegates to restartDaemon and reports success', async () => {
      restartDaemonMock.mockResolvedValue({ killedCount: 2 })

      const { registerDaemonManagementHandlers } = await importFresh()
      registerDaemonManagementHandlers()

      const handlers = buildHandlerMap()
      const result = (await handlers['pty:management:restart']({})) as { success: boolean }

      expect(result.success).toBe(true)
      expect(restartDaemonMock).toHaveBeenCalledTimes(1)
    })

    it('returns success=false when restartDaemon throws', async () => {
      restartDaemonMock.mockRejectedValue(new Error('spawn failed'))

      const { registerDaemonManagementHandlers } = await importFresh()
      registerDaemonManagementHandlers()

      const handlers = buildHandlerMap()
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const result = (await handlers['pty:management:restart']({})) as { success: boolean }
      consoleErrorSpy.mockRestore()

      expect(result.success).toBe(false)
    })
  })
})
