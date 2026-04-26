/* oxlint-disable max-lines */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const { mockPtySpawn, mockPtyInstance } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockPtyInstance: {
    pid: 12345,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn()
  }
}))

vi.mock('node-pty', () => ({
  spawn: mockPtySpawn
}))

import { PtyHandler } from './pty-handler'
import type { RelayDispatcher } from './dispatcher'

function createMockDispatcher() {
  const requestHandlers = new Map<
    string,
    (params: Record<string, unknown>, context?: { isStale: () => boolean }) => Promise<unknown>
  >()
  const notificationHandlers = new Map<string, (params: Record<string, unknown>) => void>()
  const notifications: { method: string; params?: Record<string, unknown> }[] = []

  const dispatcher = {
    onRequest: vi.fn(
      (
        method: string,
        handler: (
          params: Record<string, unknown>,
          context?: { isStale: () => boolean }
        ) => Promise<unknown>
      ) => {
        requestHandlers.set(method, handler)
      }
    ),
    onNotification: vi.fn((method: string, handler: (params: Record<string, unknown>) => void) => {
      notificationHandlers.set(method, handler)
    }),
    notify: vi.fn((method: string, params?: Record<string, unknown>) => {
      notifications.push({ method, params })
    }),
    // Helpers for tests
    _requestHandlers: requestHandlers,
    _notificationHandlers: notificationHandlers,
    _notifications: notifications,
    async callRequest(
      method: string,
      params: Record<string, unknown> = {},
      context?: { isStale: () => boolean }
    ) {
      const handler = requestHandlers.get(method)
      if (!handler) {
        throw new Error(`No handler for ${method}`)
      }
      return handler(params, context)
    },
    callNotification(method: string, params: Record<string, unknown> = {}) {
      const handler = notificationHandlers.get(method)
      if (!handler) {
        throw new Error(`No handler for ${method}`)
      }
      handler(params)
    }
  }

  return dispatcher
}

describe('PtyHandler', () => {
  let dispatcher: ReturnType<typeof createMockDispatcher>
  let handler: PtyHandler

  beforeEach(() => {
    vi.useFakeTimers()
    mockPtySpawn.mockReset()
    mockPtyInstance.onData.mockReset()
    mockPtyInstance.onExit.mockReset()
    mockPtyInstance.write.mockReset()
    mockPtyInstance.resize.mockReset()
    mockPtyInstance.kill.mockReset()
    mockPtyInstance.clear.mockReset()

    mockPtySpawn.mockReturnValue({ ...mockPtyInstance })

    dispatcher = createMockDispatcher()
    handler = new PtyHandler(dispatcher as unknown as RelayDispatcher)
  })

  afterEach(() => {
    handler.dispose()
    vi.useRealTimers()
  })

  it('registers all expected handlers', () => {
    const methods = Array.from(dispatcher._requestHandlers.keys())
    expect(methods).toContain('pty.spawn')
    expect(methods).toContain('pty.attach')
    expect(methods).toContain('pty.shutdown')
    expect(methods).toContain('pty.sendSignal')
    expect(methods).toContain('pty.getCwd')
    expect(methods).toContain('pty.getInitialCwd')
    expect(methods).toContain('pty.clearBuffer')
    expect(methods).toContain('pty.hasChildProcesses')
    expect(methods).toContain('pty.getForegroundProcess')
    expect(methods).toContain('pty.listProcesses')
    expect(methods).toContain('pty.getDefaultShell')

    const notifMethods = Array.from(dispatcher._notificationHandlers.keys())
    expect(notifMethods).toContain('pty.data')
    expect(notifMethods).toContain('pty.resize')
    expect(notifMethods).toContain('pty.ackData')
  })

  it('spawns a PTY and returns an id', async () => {
    const result = await dispatcher.callRequest('pty.spawn', { cols: 80, rows: 24 })
    expect(result).toEqual({ id: 'pty-1' })
    expect(mockPtySpawn).toHaveBeenCalled()
    expect(handler.activePtyCount).toBe(1)
  })

  it('terminates spawned PTY when request becomes stale before response', async () => {
    const term = { ...mockPtyInstance, kill: vi.fn(), onData: vi.fn(), onExit: vi.fn() }
    mockPtySpawn.mockReturnValue(term)

    await dispatcher.callRequest('pty.spawn', {}, { isStale: () => true })

    expect(term.kill).toHaveBeenCalledWith('SIGTERM')
    vi.advanceTimersByTime(5000)
    expect(term.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('increments PTY ids on each spawn', async () => {
    const r1 = await dispatcher.callRequest('pty.spawn', {})
    const r2 = await dispatcher.callRequest('pty.spawn', {})
    expect((r1 as { id: string }).id).toBe('pty-1')
    expect((r2 as { id: string }).id).toBe('pty-2')
  })

  it('accepts SIGWINCH for restored TUI repaint', async () => {
    await dispatcher.callRequest('pty.spawn', {})

    await dispatcher.callRequest('pty.sendSignal', { id: 'pty-1', signal: 'SIGWINCH' })

    const term = mockPtySpawn.mock.results[0].value
    expect(term.kill).toHaveBeenCalledWith('SIGWINCH')
  })

  it('forwards data from PTY to dispatcher notifications', async () => {
    let dataCallback: ((data: string) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn((cb: (data: string) => void) => {
        dataCallback = cb
      }),
      onExit: vi.fn()
    })

    await dispatcher.callRequest('pty.spawn', {})
    expect(dataCallback).toBeDefined()

    dataCallback!('hello world')
    expect(dispatcher.notify).toHaveBeenCalledWith('pty.data', { id: 'pty-1', data: 'hello world' })
  })

  it('returns attach replay instead of notifying when replay notification is suppressed', async () => {
    let dataCallback: ((data: string) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn((cb: (data: string) => void) => {
        dataCallback = cb
      }),
      onExit: vi.fn()
    })

    await dispatcher.callRequest('pty.spawn', {})
    dataCallback!('buffered output')

    const result = await dispatcher.callRequest('pty.attach', {
      id: 'pty-1',
      suppressReplayNotification: true
    })

    expect(result).toEqual({ replay: 'buffered output' })
    expect(dispatcher.notify).not.toHaveBeenCalledWith('pty.replay', expect.anything())
  })

  it('notifies replay on normal attach', async () => {
    let dataCallback: ((data: string) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn((cb: (data: string) => void) => {
        dataCallback = cb
      }),
      onExit: vi.fn()
    })

    await dispatcher.callRequest('pty.spawn', {})
    dataCallback!('buffered output')
    dispatcher.notify.mockClear()

    const result = await dispatcher.callRequest('pty.attach', { id: 'pty-1' })

    expect(result).toEqual({})
    expect(dispatcher.notify).toHaveBeenCalledWith('pty.replay', {
      id: 'pty-1',
      data: 'buffered output'
    })
  })

  it('notifies on PTY exit and removes from map', async () => {
    let exitCallback: ((info: { exitCode: number }) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn(),
      onExit: vi.fn((cb: (info: { exitCode: number }) => void) => {
        exitCallback = cb
      })
    })

    await dispatcher.callRequest('pty.spawn', {})
    expect(handler.activePtyCount).toBe(1)

    exitCallback!({ exitCode: 0 })
    expect(dispatcher.notify).toHaveBeenCalledWith('pty.exit', { id: 'pty-1', code: 0 })
    expect(handler.activePtyCount).toBe(0)
  })

  it('writes data to PTY via pty.data notification', async () => {
    const mockWrite = vi.fn()
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      write: mockWrite,
      onData: vi.fn(),
      onExit: vi.fn()
    })

    await dispatcher.callRequest('pty.spawn', {})
    dispatcher.callNotification('pty.data', { id: 'pty-1', data: 'ls\n' })
    expect(mockWrite).toHaveBeenCalledWith('ls\n')
  })

  it('resizes PTY via pty.resize notification', async () => {
    const mockResize = vi.fn()
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      resize: mockResize,
      onData: vi.fn(),
      onExit: vi.fn()
    })

    await dispatcher.callRequest('pty.spawn', {})
    dispatcher.callNotification('pty.resize', { id: 'pty-1', cols: 120, rows: 40 })
    expect(mockResize).toHaveBeenCalledWith(120, 40)
  })

  it('kills PTY on shutdown with SIGTERM by default', async () => {
    const mockKill = vi.fn()
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      kill: mockKill,
      onData: vi.fn(),
      onExit: vi.fn()
    })

    await dispatcher.callRequest('pty.spawn', {})
    await dispatcher.callRequest('pty.shutdown', { id: 'pty-1', immediate: false })
    expect(mockKill).toHaveBeenCalledWith('SIGTERM')
  })

  it('kills PTY on shutdown with SIGKILL when immediate', async () => {
    const mockKill = vi.fn()
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      kill: mockKill,
      onData: vi.fn(),
      onExit: vi.fn()
    })

    await dispatcher.callRequest('pty.spawn', {})
    await dispatcher.callRequest('pty.shutdown', { id: 'pty-1', immediate: true })
    expect(mockKill).toHaveBeenCalledWith('SIGKILL')
  })

  it('throws for attach on nonexistent PTY', async () => {
    await expect(dispatcher.callRequest('pty.attach', { id: 'pty-999' })).rejects.toThrow(
      'PTY "pty-999" not found'
    )
  })

  it('grace timer waits full period even when no PTYs exist', () => {
    const onExpire = vi.fn()
    handler.startGraceTimer(onExpire)
    expect(onExpire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(5 * 60 * 1000)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('grace timer fires after configured delay when PTYs exist', async () => {
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn(),
      onExit: vi.fn()
    })
    await dispatcher.callRequest('pty.spawn', {})

    const onExpire = vi.fn()
    handler.startGraceTimer(onExpire)
    expect(onExpire).not.toHaveBeenCalled()

    vi.advanceTimersByTime(5 * 60 * 1000)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('cancelGraceTimer prevents expiration', async () => {
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn(),
      onExit: vi.fn()
    })
    await dispatcher.callRequest('pty.spawn', {})

    const onExpire = vi.fn()
    handler.startGraceTimer(onExpire)

    vi.advanceTimersByTime(60_000)
    handler.cancelGraceTimer()

    vi.advanceTimersByTime(5 * 60 * 1000)
    expect(onExpire).not.toHaveBeenCalled()
  })

  it('clearAllBuffers empties every PTY replay buffer', async () => {
    let dataCallback1: ((data: string) => void) | undefined
    let dataCallback2: ((data: string) => void) | undefined
    let callCount = 0
    mockPtySpawn.mockImplementation(() => {
      callCount++
      const cb = callCount === 1 ? 'cb1' : 'cb2'
      return {
        ...mockPtyInstance,
        onData: vi.fn((fn: (data: string) => void) => {
          if (cb === 'cb1') {
            dataCallback1 = fn
          } else {
            dataCallback2 = fn
          }
        }),
        onExit: vi.fn()
      }
    })

    await dispatcher.callRequest('pty.spawn', {})
    await dispatcher.callRequest('pty.spawn', {})
    dataCallback1!('output from pty-1')
    dataCallback2!('output from pty-2')

    handler.clearAllBuffers()

    const r1 = await dispatcher.callRequest('pty.attach', {
      id: 'pty-1',
      suppressReplayNotification: true
    })
    const r2 = await dispatcher.callRequest('pty.attach', {
      id: 'pty-2',
      suppressReplayNotification: true
    })
    expect(r1).toEqual({})
    expect(r2).toEqual({})
  })

  it('after clearAllBuffers, only post-disconnect output is replayed', async () => {
    let dataCallback: ((data: string) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn((cb: (data: string) => void) => {
        dataCallback = cb
      }),
      onExit: vi.fn()
    })

    await dispatcher.callRequest('pty.spawn', {})

    dataCallback!('pre-disconnect output')

    handler.clearAllBuffers()

    dataCallback!('post-disconnect output')

    const result = await dispatcher.callRequest('pty.attach', {
      id: 'pty-1',
      suppressReplayNotification: true
    })
    expect(result).toEqual({ replay: 'post-disconnect output' })
  })

  it('attach clears buffer so a second attach returns nothing', async () => {
    let dataCallback: ((data: string) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn((cb: (data: string) => void) => {
        dataCallback = cb
      }),
      onExit: vi.fn()
    })

    await dispatcher.callRequest('pty.spawn', {})
    dataCallback!('some output')

    await dispatcher.callRequest('pty.attach', {
      id: 'pty-1',
      suppressReplayNotification: true
    })

    const result = await dispatcher.callRequest('pty.attach', {
      id: 'pty-1',
      suppressReplayNotification: true
    })
    expect(result).toEqual({})
  })

  it('simulates full disconnect-reconnect cycle without duplicate replay', async () => {
    let dataCallback: ((data: string) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn((cb: (data: string) => void) => {
        dataCallback = cb
      }),
      onExit: vi.fn()
    })

    await dispatcher.callRequest('pty.spawn', {})

    dataCallback!('line 1\r\n')
    dataCallback!('line 2\r\n')

    handler.clearAllBuffers()

    dataCallback!('line 3 (during disconnect)\r\n')

    dispatcher.notify.mockClear()
    const result = await dispatcher.callRequest('pty.attach', { id: 'pty-1' })

    expect(result).toEqual({})
    expect(dispatcher.notify).toHaveBeenCalledWith('pty.replay', {
      id: 'pty-1',
      data: 'line 3 (during disconnect)\r\n'
    })
    expect(dispatcher.notify).toHaveBeenCalledTimes(1)
  })

  it('dispose kills all PTYs', async () => {
    const mockKill = vi.fn()
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      kill: mockKill,
      onData: vi.fn(),
      onExit: vi.fn()
    })

    await dispatcher.callRequest('pty.spawn', {})
    await dispatcher.callRequest('pty.spawn', {})
    expect(handler.activePtyCount).toBe(2)

    handler.dispose()
    expect(mockKill).toHaveBeenCalledWith('SIGTERM')
    expect(handler.activePtyCount).toBe(0)
  })
})
