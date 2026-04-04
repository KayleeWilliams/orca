import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  onMock,
  removeAllListenersMock,
  setPermissionRequestHandlerMock,
  registerRepoHandlersMock,
  registerWorktreeHandlersMock,
  registerPtyHandlersMock,
  setupAutoUpdaterMock
} = vi.hoisted(() => ({
  onMock: vi.fn(),
  removeAllListenersMock: vi.fn(),
  setPermissionRequestHandlerMock: vi.fn(),
  registerRepoHandlersMock: vi.fn(),
  registerWorktreeHandlersMock: vi.fn(),
  registerPtyHandlersMock: vi.fn(),
  setupAutoUpdaterMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {},
  clipboard: {},
  ipcMain: {
    on: onMock,
    removeAllListeners: removeAllListenersMock,
    removeHandler: vi.fn(),
    handle: vi.fn()
  }
}))

vi.mock('../ipc/repos', () => ({
  registerRepoHandlers: registerRepoHandlersMock
}))

vi.mock('../ipc/worktrees', () => ({
  registerWorktreeHandlers: registerWorktreeHandlersMock
}))

vi.mock('../ipc/pty', () => ({
  registerPtyHandlers: registerPtyHandlersMock
}))

vi.mock('../updater', () => ({
  checkForUpdates: vi.fn(),
  getUpdateStatus: vi.fn(),
  quitAndInstall: vi.fn(),
  setupAutoUpdater: setupAutoUpdaterMock
}))

import { attachMainWindowServices } from './attach-main-window-services'

describe('attachMainWindowServices', () => {
  beforeEach(() => {
    onMock.mockReset()
    removeAllListenersMock.mockReset()
    setPermissionRequestHandlerMock.mockReset()
    registerRepoHandlersMock.mockReset()
    registerWorktreeHandlersMock.mockReset()
    registerPtyHandlersMock.mockReset()
    setupAutoUpdaterMock.mockReset()
  })

  it('only allows the explicit permission allowlist', () => {
    const mainWindow = {
      on: vi.fn(),
      webContents: {
        on: vi.fn(),
        session: {
          setPermissionRequestHandler: setPermissionRequestHandlerMock
        }
      }
    }
    const store = { flush: vi.fn() }
    const runtime = {
      attachWindow: vi.fn(),
      setNotifier: vi.fn(),
      markRendererReloading: vi.fn(),
      markGraphUnavailable: vi.fn()
    }

    attachMainWindowServices(mainWindow as never, store as never, runtime as never)

    expect(setPermissionRequestHandlerMock).toHaveBeenCalledTimes(1)
    const permissionHandler = setPermissionRequestHandlerMock.mock.calls[0][0]
    const callback = vi.fn()

    permissionHandler(null, 'media', callback)
    permissionHandler(null, 'fullscreen', callback)
    permissionHandler(null, 'pointerLock', callback)
    permissionHandler(null, 'clipboard-read', callback)

    expect(callback.mock.calls).toEqual([[true], [true], [true], [false]])
  })

  it('forwards runtime notifier events to the renderer', () => {
    const sendMock = vi.fn()
    const webContentsOnMock = vi.fn()
    const mainWindowOnMock = vi.fn()
    const mainWindow = {
      isDestroyed: vi.fn(() => false),
      on: mainWindowOnMock,
      webContents: {
        on: webContentsOnMock,
        send: sendMock,
        session: {
          setPermissionRequestHandler: setPermissionRequestHandlerMock
        }
      }
    }
    const store = { flush: vi.fn() }
    const runtime = {
      attachWindow: vi.fn(),
      setNotifier: vi.fn(),
      markRendererReloading: vi.fn(),
      markGraphUnavailable: vi.fn()
    }

    attachMainWindowServices(mainWindow as never, store as never, runtime as never)

    expect(runtime.setNotifier).toHaveBeenCalledTimes(1)
    const notifier = runtime.setNotifier.mock.calls[0][0] as {
      worktreesChanged: (repoId: string) => void
      reposChanged: () => void
      activateWorktree: (repoId: string, worktreeId: string) => void
    }

    notifier.worktreesChanged('repo-1')
    notifier.reposChanged()
    notifier.activateWorktree('repo-1', 'wt-1')

    expect(sendMock.mock.calls).toEqual([
      ['worktrees:changed', { repoId: 'repo-1' }],
      ['repos:changed'],
      ['ui:activateWorktree', { repoId: 'repo-1', worktreeId: 'wt-1' }]
    ])
  })
})
