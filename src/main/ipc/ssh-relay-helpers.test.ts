import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockDeployAndLaunchRelay,
  mockMux,
  mockPtyProvider,
  mockRegisterSshPtyProvider,
  mockUnregisterSshPtyProvider,
  mockGetSshPtyProvider,
  mockGetPtyIdsForConnection,
  mockClearProviderPtyState,
  mockDeletePtyOwnership,
  mockRegisterSshFilesystemProvider,
  mockUnregisterSshFilesystemProvider,
  mockGetSshFilesystemProvider,
  mockRegisterSshGitProvider,
  mockUnregisterSshGitProvider
} = vi.hoisted(() => ({
  mockDeployAndLaunchRelay: vi.fn(),
  mockMux: {
    dispose: vi.fn(),
    isDisposed: vi.fn().mockReturnValue(false),
    notify: vi.fn(),
    request: vi.fn(),
    onNotification: vi.fn().mockReturnValue(() => {})
  },
  mockPtyProvider: {
    attach: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn()
  },
  mockRegisterSshPtyProvider: vi.fn(),
  mockUnregisterSshPtyProvider: vi.fn(),
  mockGetSshPtyProvider: vi.fn(),
  mockGetPtyIdsForConnection: vi.fn(),
  mockClearProviderPtyState: vi.fn(),
  mockDeletePtyOwnership: vi.fn(),
  mockRegisterSshFilesystemProvider: vi.fn(),
  mockUnregisterSshFilesystemProvider: vi.fn(),
  mockGetSshFilesystemProvider: vi.fn(),
  mockRegisterSshGitProvider: vi.fn(),
  mockUnregisterSshGitProvider: vi.fn()
}))

vi.mock('../ssh/ssh-relay-deploy', () => ({
  deployAndLaunchRelay: mockDeployAndLaunchRelay
}))

vi.mock('../ssh/ssh-channel-multiplexer', () => ({
  SshChannelMultiplexer: class MockSshChannelMultiplexer {
    constructor() {
      return mockMux
    }
  }
}))

vi.mock('../providers/ssh-pty-provider', () => ({
  SshPtyProvider: class MockSshPtyProvider {
    constructor() {
      return mockPtyProvider
    }
  }
}))

vi.mock('../providers/ssh-filesystem-provider', () => ({
  SshFilesystemProvider: class MockSshFilesystemProvider {}
}))

vi.mock('../providers/ssh-git-provider', () => ({
  SshGitProvider: class MockSshGitProvider {}
}))

vi.mock('./pty', () => ({
  registerSshPtyProvider: mockRegisterSshPtyProvider,
  unregisterSshPtyProvider: mockUnregisterSshPtyProvider,
  getSshPtyProvider: mockGetSshPtyProvider,
  getPtyIdsForConnection: mockGetPtyIdsForConnection,
  clearPtyOwnershipForConnection: vi.fn(),
  clearProviderPtyState: mockClearProviderPtyState,
  deletePtyOwnership: mockDeletePtyOwnership
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  registerSshFilesystemProvider: mockRegisterSshFilesystemProvider,
  unregisterSshFilesystemProvider: mockUnregisterSshFilesystemProvider,
  getSshFilesystemProvider: mockGetSshFilesystemProvider
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  registerSshGitProvider: mockRegisterSshGitProvider,
  unregisterSshGitProvider: mockUnregisterSshGitProvider
}))

import { reestablishRelayStack } from './ssh-relay-helpers'

describe('reestablishRelayStack', () => {
  const mockWindow = {
    isDestroyed: () => false,
    webContents: {
      send: vi.fn()
    }
  }
  const mockConnection = {}
  const mockConnectionManager = {
    getConnection: vi.fn()
  }
  const activeMultiplexers = new Map()
  const store = {
    getRepos: vi.fn().mockReturnValue([])
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockConnectionManager.getConnection.mockReturnValue(mockConnection)
    mockDeployAndLaunchRelay.mockResolvedValue({
      transport: { write: vi.fn(), onData: vi.fn(), onClose: vi.fn() }
    })
    mockGetPtyIdsForConnection.mockReturnValue([])
    mockPtyProvider.attach.mockResolvedValue(undefined)
    activeMultiplexers.clear()
  })

  it('invalidates and broadcasts remote PTYs that cannot reattach after relay reconnect', async () => {
    mockGetPtyIdsForConnection.mockReturnValue(['pty-stale'])
    mockPtyProvider.attach.mockRejectedValue(new Error('PTY "pty-stale" not found'))

    await reestablishRelayStack(
      'ssh-1',
      () => mockWindow as never,
      mockConnectionManager as never,
      activeMultiplexers,
      null,
      store as never
    )

    expect(mockPtyProvider.attach).toHaveBeenCalledWith('pty-stale')
    expect(mockClearProviderPtyState).toHaveBeenCalledWith('pty-stale')
    expect(mockDeletePtyOwnership).toHaveBeenCalledWith('pty-stale')
    expect(mockWindow.webContents.send).toHaveBeenCalledWith('pty:exit', {
      id: 'pty-stale',
      code: -1
    })
  })
})
