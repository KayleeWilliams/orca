import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handleMock,
  onMock,
  removeHandlerMock,
  removeAllListenersMock,
  existsSyncMock,
  statSyncMock,
  accessSyncMock,
  spawnMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  onMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  removeAllListenersMock: vi.fn(),
  existsSyncMock: vi.fn(),
  statSyncMock: vi.fn(),
  accessSyncMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock,
    on: onMock,
    removeHandler: removeHandlerMock,
    removeAllListeners: removeAllListenersMock
  }
}))

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  statSync: statSyncMock,
  accessSync: accessSyncMock,
  constants: {
    X_OK: 1
  }
}))

vi.mock('node-pty', () => ({
  spawn: spawnMock
}))

import { registerPtyHandlers } from './pty'

describe('registerPtyHandlers', () => {
  const handlers = new Map<string, (_event: unknown, args: unknown) => unknown>()
  const mainWindow = {
    isDestroyed: () => false,
    webContents: {
      on: vi.fn(),
      send: vi.fn()
    }
  }

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    onMock.mockReset()
    removeHandlerMock.mockReset()
    removeAllListenersMock.mockReset()
    existsSyncMock.mockReset()
    statSyncMock.mockReset()
    accessSyncMock.mockReset()
    spawnMock.mockReset()
    mainWindow.webContents.on.mockReset()
    mainWindow.webContents.send.mockReset()

    handleMock.mockImplementation((channel, handler) => {
      handlers.set(channel, handler)
    })
    existsSyncMock.mockReturnValue(true)
    statSyncMock.mockReturnValue({ isDirectory: () => true })
    spawnMock.mockReturnValue({
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn()
    })
  })

  /** Helper: trigger pty:spawn and return the env passed to node-pty. */
  function spawnAndGetEnv(
    argsEnv?: Record<string, string>,
    processEnvOverrides?: Record<string, string | undefined>
  ): Record<string, string> {
    const savedEnv: Record<string, string | undefined> = {}
    if (processEnvOverrides) {
      for (const [k, v] of Object.entries(processEnvOverrides)) {
        savedEnv[k] = process.env[k]
        if (v === undefined) {
          delete process.env[k]
        } else {
          process.env[k] = v
        }
      }
    }

    try {
      // Clear previously registered handlers so re-registration doesn't
      // accumulate stale state across calls within one test.
      handlers.clear()
      registerPtyHandlers(mainWindow as never)
      handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        ...(argsEnv ? { env: argsEnv } : {})
      })
      const spawnCall = spawnMock.mock.calls.at(-1)!
      return spawnCall[2].env as Record<string, string>
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) {
          delete process.env[k]
        } else {
          process.env[k] = v
        }
      }
    }
  }

  describe('spawn environment', () => {
    it('defaults LANG to en_US.UTF-8 when not inherited from process.env', () => {
      const env = spawnAndGetEnv(undefined, { LANG: undefined })
      expect(env.LANG).toBe('en_US.UTF-8')
    })

    it('inherits LANG from process.env when already set', () => {
      const env = spawnAndGetEnv(undefined, { LANG: 'ja_JP.UTF-8' })
      expect(env.LANG).toBe('ja_JP.UTF-8')
    })

    it('lets caller-provided env override LANG', () => {
      const env = spawnAndGetEnv({ LANG: 'fr_FR.UTF-8' })
      expect(env.LANG).toBe('fr_FR.UTF-8')
    })

    it('always sets TERM and COLORTERM regardless of env', () => {
      const env = spawnAndGetEnv()
      expect(env.TERM).toBe('xterm-256color')
      expect(env.COLORTERM).toBe('truecolor')
      expect(env.TERM_PROGRAM).toBe('Orca')
    })
  })

  it('rejects missing WSL worktree cwd instead of validating only the fallback Windows cwd', () => {
    const originalPlatform = process.platform
    const originalUserProfile = process.env.USERPROFILE

    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    process.env.USERPROFILE = 'C:\\Users\\jinwo'

    existsSyncMock.mockImplementation((targetPath: string) => {
      if (targetPath === '\\\\wsl.localhost\\Ubuntu\\home\\jin\\missing') {
        return false
      }
      return true
    })

    try {
      registerPtyHandlers(mainWindow as never)

      expect(() =>
        handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\missing'
        })
      ).toThrow('Working directory "\\\\wsl.localhost\\Ubuntu\\home\\jin\\missing" does not exist.')
      expect(spawnMock).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE
      } else {
        process.env.USERPROFILE = originalUserProfile
      }
    }
  })
})
