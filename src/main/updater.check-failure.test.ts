import { beforeEach, describe, expect, it, vi } from 'vitest'

const { appMock, browserWindowMock, nativeUpdaterMock, autoUpdaterMock, isMock, killAllPtyMock } =
  vi.hoisted(() => {
    const appEventHandlers = new Map<string, ((...args: unknown[]) => void)[]>()
    const eventHandlers = new Map<string, ((...args: unknown[]) => void)[]>()

    const appOn = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const handlers = appEventHandlers.get(event) ?? []
      handlers.push(handler)
      appEventHandlers.set(event, handlers)
      return appMock
    })

    const on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const handlers = eventHandlers.get(event) ?? []
      handlers.push(handler)
      eventHandlers.set(event, handlers)
      return autoUpdaterMock
    })

    const emit = (event: string, ...args: unknown[]) => {
      for (const handler of eventHandlers.get(event) ?? []) {
        handler(...args)
      }
    }

    const reset = () => {
      appEventHandlers.clear()
      appOn.mockClear()
      eventHandlers.clear()
      on.mockClear()
      autoUpdaterMock.checkForUpdates.mockReset()
      autoUpdaterMock.downloadUpdate.mockReset()
      autoUpdaterMock.quitAndInstall.mockReset()
    }

    const autoUpdaterMock = {
      autoDownload: false,
      autoInstallOnAppQuit: false,
      on,
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
      quitAndInstall: vi.fn(),
      setFeedURL: vi.fn(),
      emit,
      reset
    }

    return {
      appMock: {
        isPackaged: true,
        getVersion: vi.fn(() => '1.0.51'),
        on: appOn,
        quit: vi.fn()
      },
      browserWindowMock: {
        getAllWindows: vi.fn(() => [])
      },
      nativeUpdaterMock: {
        on: vi.fn()
      },
      autoUpdaterMock,
      isMock: { dev: false },
      killAllPtyMock: vi.fn()
    }
  })

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: browserWindowMock,
  autoUpdater: nativeUpdaterMock,
  powerMonitor: { on: vi.fn() },
  net: { fetch: vi.fn() }
}))

vi.mock('electron-updater', () => ({
  autoUpdater: autoUpdaterMock
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: isMock
}))

vi.mock('./ipc/pty', () => ({
  killAllPty: killAllPtyMock
}))

vi.mock('./updater-nudge', () => ({
  fetchNudge: vi.fn().mockResolvedValue(null),
  shouldApplyNudge: vi.fn().mockReturnValue(false)
}))

describe('updater check failure handling', () => {
  beforeEach(() => {
    vi.resetModules()
    autoUpdaterMock.reset()
    nativeUpdaterMock.on.mockReset()
    browserWindowMock.getAllWindows.mockReset()
    browserWindowMock.getAllWindows.mockReturnValue([])
    appMock.getVersion.mockReset()
    appMock.getVersion.mockReturnValue('1.0.51')
    appMock.quit.mockReset()
    appMock.isPackaged = true
    isMock.dev = false
    killAllPtyMock.mockReset()
    vi.unstubAllGlobals()
  })

  it('surfaces GitHub release transition errors to user-initiated checks', async () => {
    autoUpdaterMock.checkForUpdates.mockResolvedValueOnce(undefined).mockImplementationOnce(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('error', new Error('Unable to find latest version on GitHub'))
      })
      return Promise.reject(new Error('Unable to find latest version on GitHub'))
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never)
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      // Why: a user-initiated benign failure must show a visible error. Silently
      // sending 'idle' (or 'not-available') makes the button look broken.
      expect(statuses).toContainEqual(
        expect.objectContaining({
          state: 'error',
          userInitiated: true,
          message: expect.stringContaining('GitHub may be temporarily unavailable')
        })
      )
      expect(statuses).not.toContainEqual(
        expect.objectContaining({ state: 'not-available', userInitiated: true })
      )
    })
  })

  it('surfaces missing latest-mac.yml to user-initiated checks', async () => {
    autoUpdaterMock.checkForUpdates.mockResolvedValueOnce(undefined).mockImplementationOnce(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit(
          'error',
          new Error('Cannot find channel "latest-mac.yml" update info: HttpError: 404')
        )
      })
      return Promise.reject(
        new Error('Cannot find channel "latest-mac.yml" update info: HttpError: 404')
      )
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never)
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual(
        expect.objectContaining({
          state: 'error',
          userInitiated: true,
          message: expect.stringContaining('GitHub may be temporarily unavailable')
        })
      )
      expect(statuses).not.toContainEqual(
        expect.objectContaining({ state: 'not-available', userInitiated: true })
      )
    })
  })

  it('silently drops background benign failures to idle', async () => {
    // Why: background checks must stay quiet; only user-initiated clicks get
    // an error card. This prevents noisy nag during a release transition.
    autoUpdaterMock.checkForUpdates.mockImplementationOnce(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('error', new Error('Unable to find latest version on GitHub'))
      })
      return Promise.reject(new Error('Unable to find latest version on GitHub'))
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdates } = await import('./updater')

    setupAutoUpdater(mainWindow as never)
    checkForUpdates()
    await vi.waitFor(() => {
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({ state: 'idle' })
      expect(statuses).not.toContainEqual(expect.objectContaining({ state: 'error' }))
    })
  })

  it('does not clobber a user-initiated error with a later background benign failure', async () => {
    // Why: protects the guard in sendCheckFailureStatus (src/main/updater.ts
    // lines 220-222). Once a user-initiated benign failure has produced a
    // visible {state:'error', userInitiated:true} card, the scheduled
    // background retry (which also benign-fails) must NOT silently push
    // {state:'idle'} and erase the visible error. The card must persist
    // until the user retries or dismisses.
    autoUpdaterMock.checkForUpdates
      // 1st: startup background check from setupAutoUpdater — swallow it.
      .mockResolvedValueOnce(undefined)
      // 2nd: user-initiated check — benign fail.
      .mockImplementationOnce(() => {
        autoUpdaterMock.emit('checking-for-update')
        queueMicrotask(() => {
          autoUpdaterMock.emit('error', new Error('Unable to find latest version on GitHub'))
        })
        return Promise.reject(new Error('Unable to find latest version on GitHub'))
      })
      // 3rd: subsequent background retry — also benign-fails. We drive the
      // failure via the rejected promise path (rather than emitting
      // 'checking-for-update' first) so the guard under test is actually
      // exercised: the guard reads currentStatus, and 'checking-for-update'
      // would have clobbered it to {state:'checking'} before the guard runs.
      .mockImplementationOnce(() =>
        Promise.reject(new Error('Unable to find latest version on GitHub'))
      )

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu, checkForUpdates } = await import('./updater')

    setupAutoUpdater(mainWindow as never)

    // User-initiated benign failure → visible error card.
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual(
        expect.objectContaining({
          state: 'error',
          userInitiated: true,
          message: expect.stringContaining('GitHub may be temporarily unavailable')
        })
      )
    })

    const errorIndex = sendMock.mock.calls.findIndex(
      ([channel, status]) =>
        channel === 'updater:status' && status?.state === 'error' && status?.userInitiated === true
    )
    expect(errorIndex).toBeGreaterThanOrEqual(0)

    // Background benign retry — must NOT clobber the visible error to 'idle'.
    checkForUpdates()
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(3)
    })
    // Give the failure handler a chance to flush through microtasks.
    await new Promise((resolve) => setTimeout(resolve, 10))

    const statusesAfterError = sendMock.mock.calls
      .slice(errorIndex + 1)
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
    expect(statusesAfterError).not.toContainEqual(expect.objectContaining({ state: 'idle' }))

    // Terminal status must still be the user-initiated error.
    const allStatuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
    const terminal = allStatuses.at(-1)
    expect(terminal).toEqual(expect.objectContaining({ state: 'error', userInitiated: true }))
  })

  it('does not clobber a user-initiated error with a later background update-not-available', async () => {
    // Why: protects the guard in updater-events.ts (lines 166-173). Once a
    // user-initiated benign failure has produced a visible
    // {state:'error', userInitiated:true} card, a subsequent background
    // check that resolves via 'update-not-available' must NOT flip the UI
    // to {state:'not-available'} and silently wipe the visible error. A
    // user-initiated error persists until the user acts.
    autoUpdaterMock.checkForUpdates
      // 1st: startup background check from setupAutoUpdater — swallow it.
      .mockResolvedValueOnce(undefined)
      // 2nd: user-initiated check — benign fail.
      .mockImplementationOnce(() => {
        autoUpdaterMock.emit('checking-for-update')
        queueMicrotask(() => {
          autoUpdaterMock.emit('error', new Error('Unable to find latest version on GitHub'))
        })
        return Promise.reject(new Error('Unable to find latest version on GitHub'))
      })
      // 3rd: subsequent background check — succeeds benignly via
      // 'update-not-available'. We skip emitting 'checking-for-update' so
      // the guard under test (in updater-events 'update-not-available'
      // handler) is exercised against the visible error currentStatus —
      // an intervening 'checking-for-update' would have clobbered
      // currentStatus to {state:'checking'} before the guard runs.
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          autoUpdaterMock.emit('update-not-available', { version: '1.0.51' })
        })
        return Promise.resolve(undefined)
      })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu, checkForUpdates } = await import('./updater')

    setupAutoUpdater(mainWindow as never)

    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual(
        expect.objectContaining({
          state: 'error',
          userInitiated: true,
          message: expect.stringContaining('GitHub may be temporarily unavailable')
        })
      )
    })

    const errorIndex = sendMock.mock.calls.findIndex(
      ([channel, status]) =>
        channel === 'updater:status' && status?.state === 'error' && status?.userInitiated === true
    )
    expect(errorIndex).toBeGreaterThanOrEqual(0)

    // Background benign success — must NOT clobber the visible error.
    checkForUpdates()
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(3)
    })
    await new Promise((resolve) => setTimeout(resolve, 10))

    const statusesAfterError = sendMock.mock.calls
      .slice(errorIndex + 1)
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
    // Neither undefined nor false userInitiated should flip us to not-available.
    expect(statusesAfterError).not.toContainEqual(
      expect.objectContaining({ state: 'not-available', userInitiated: undefined })
    )
    expect(statusesAfterError).not.toContainEqual(
      expect.objectContaining({ state: 'not-available', userInitiated: false })
    )

    const allStatuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
    const terminal = allStatuses.at(-1)
    expect(terminal).toEqual(expect.objectContaining({ state: 'error', userInitiated: true }))
  })
})
