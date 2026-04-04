import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handleMock,
  removeHandlerMock,
  listWorktreesMock,
  addWorktreeMock,
  removeWorktreeMock,
  getGitUsernameMock,
  getDefaultBaseRefMock,
  getBranchConflictKindMock,
  getPRForBranchMock,
  getEffectiveHooksMock,
  runHookMock,
  hasHooksFileMock,
  loadHooksMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  listWorktreesMock: vi.fn(),
  addWorktreeMock: vi.fn(),
  removeWorktreeMock: vi.fn(),
  getGitUsernameMock: vi.fn(),
  getDefaultBaseRefMock: vi.fn(),
  getBranchConflictKindMock: vi.fn(),
  getPRForBranchMock: vi.fn(),
  getEffectiveHooksMock: vi.fn(),
  runHookMock: vi.fn(),
  hasHooksFileMock: vi.fn(),
  loadHooksMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock,
    removeHandler: removeHandlerMock
  }
}))

vi.mock('../git/worktree', () => ({
  listWorktrees: listWorktreesMock,
  addWorktree: addWorktreeMock,
  removeWorktree: removeWorktreeMock
}))

vi.mock('../git/repo', () => ({
  getGitUsername: getGitUsernameMock,
  getDefaultBaseRef: getDefaultBaseRefMock,
  getBranchConflictKind: getBranchConflictKindMock
}))

vi.mock('../github/client', () => ({
  getPRForBranch: getPRForBranchMock
}))

vi.mock('../hooks', () => ({
  getEffectiveHooks: getEffectiveHooksMock,
  loadHooks: loadHooksMock,
  runHook: runHookMock,
  hasHooksFile: hasHooksFileMock
}))

import { registerWorktreeHandlers } from './worktrees'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => unknown>

describe('registerWorktreeHandlers', () => {
  const handlers: HandlerMap = {}
  const mainWindow = {
    isDestroyed: () => false,
    webContents: {
      send: vi.fn()
    }
  }
  const store = {
    getRepos: vi.fn(),
    getRepo: vi.fn(),
    getSettings: vi.fn(),
    getWorktreeMeta: vi.fn(),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn()
  }

  beforeEach(() => {
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    listWorktreesMock.mockReset()
    addWorktreeMock.mockReset()
    removeWorktreeMock.mockReset()
    getGitUsernameMock.mockReset()
    getDefaultBaseRefMock.mockReset()
    getBranchConflictKindMock.mockReset()
    getPRForBranchMock.mockReset()
    getEffectiveHooksMock.mockReset()
    runHookMock.mockReset()
    hasHooksFileMock.mockReset()
    loadHooksMock.mockReset()
    mainWindow.webContents.send.mockReset()
    store.getRepos.mockReset()
    store.getRepo.mockReset()
    store.getSettings.mockReset()
    store.getWorktreeMeta.mockReset()
    store.setWorktreeMeta.mockReset()
    store.removeWorktreeMeta.mockReset()

    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }

    handleMock.mockImplementation((channel, handler) => {
      handlers[channel] = handler
    })

    store.getRepo.mockReturnValue({
      id: 'repo-1',
      path: '/workspace/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      worktreeBaseRef: null
    })
    store.getSettings.mockReturnValue({
      branchPrefix: 'none',
      nestWorkspaces: false,
      workspaceDir: '/workspace'
    })
    store.getWorktreeMeta.mockReturnValue(undefined)
    store.setWorktreeMeta.mockReturnValue({})
    getGitUsernameMock.mockReturnValue('')
    getDefaultBaseRefMock.mockReturnValue('origin/main')
    getBranchConflictKindMock.mockResolvedValue(null)
    getPRForBranchMock.mockResolvedValue(null)
    getEffectiveHooksMock.mockReturnValue(null)
    listWorktreesMock.mockResolvedValue([])

    registerWorktreeHandlers(mainWindow as never, store as never)
  })

  it('rejects worktree creation when the branch already exists on a remote', async () => {
    getBranchConflictKindMock.mockResolvedValue('remote')

    await expect(
      handlers['worktrees:create'](null, {
        repoId: 'repo-1',
        name: 'improve-dashboard'
      })
    ).rejects.toThrow(
      'Branch "improve-dashboard" already exists on a remote. Pick a different worktree name.'
    )

    expect(getPRForBranchMock).not.toHaveBeenCalled()
    expect(addWorktreeMock).not.toHaveBeenCalled()
  })

  it('rejects worktree creation when the branch name already belongs to a PR', async () => {
    getPRForBranchMock.mockResolvedValue({
      number: 3127,
      title: 'Existing PR',
      state: 'merged',
      url: 'https://example.com/pr/3127',
      checksStatus: 'success',
      updatedAt: '2026-04-01T00:00:00Z',
      mergeable: 'UNKNOWN'
    })

    await expect(
      handlers['worktrees:create'](null, {
        repoId: 'repo-1',
        name: 'improve-dashboard'
      })
    ).rejects.toThrow(
      'Branch "improve-dashboard" already has PR #3127. Pick a different worktree name.'
    )

    expect(addWorktreeMock).not.toHaveBeenCalled()
  })

  it('accepts a newly created Windows worktree when git lists the same path with different separators', async () => {
    const originalPlatform = process.platform
    try {
      Object.defineProperty(process, 'platform', {
        value: 'win32'
      })
      store.getRepo.mockReturnValue({
        id: 'repo-1',
        path: 'C:\\repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0,
        worktreeBaseRef: null
      })
      store.getSettings.mockReturnValue({
        branchPrefix: 'none',
        nestWorkspaces: false,
        workspaceDir: 'C:\\workspaces'
      })
      listWorktreesMock.mockResolvedValue([
        {
          path: 'C:/workspaces/improve-dashboard',
          head: 'abc123',
          branch: 'refs/heads/improve-dashboard',
          isBare: false,
          isMainWorktree: false
        }
      ])

      const result = await handlers['worktrees:create'](null, {
        repoId: 'repo-1',
        name: 'improve-dashboard'
      })

      expect(addWorktreeMock).toHaveBeenCalledWith(
        'C:\\repo',
        'C:\\workspaces\\improve-dashboard',
        'improve-dashboard',
        'origin/main'
      )
      expect(store.setWorktreeMeta).toHaveBeenCalledWith(
        'repo-1::C:/workspaces/improve-dashboard',
        expect.objectContaining({
          lastActivityAt: expect.any(Number)
        })
      )
      expect(result).toMatchObject({
        id: 'repo-1::C:/workspaces/improve-dashboard',
        path: 'C:/workspaces/improve-dashboard',
        branch: 'refs/heads/improve-dashboard'
      })
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform
      })
    }
  })

  it('preserves create-time metadata on the next list when Windows path formatting differs', async () => {
    const originalPlatform = process.platform
    try {
      Object.defineProperty(process, 'platform', {
        value: 'win32'
      })
      store.getRepo.mockReturnValue({
        id: 'repo-1',
        path: 'C:\\repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0,
        worktreeBaseRef: null
      })
      store.getSettings.mockReturnValue({
        branchPrefix: 'none',
        nestWorkspaces: false,
        workspaceDir: 'C:\\workspaces'
      })
      listWorktreesMock
        .mockResolvedValueOnce([
          {
            path: 'C:/workspaces/improve-dashboard',
            head: 'abc123',
            branch: 'refs/heads/improve-dashboard',
            isBare: false,
            isMainWorktree: false
          }
        ])
        .mockResolvedValueOnce([
          {
            path: 'C:/workspaces/improve-dashboard',
            head: 'abc123',
            branch: 'refs/heads/improve-dashboard',
            isBare: false,
            isMainWorktree: false
          }
        ])
      store.setWorktreeMeta.mockReturnValue({
        lastActivityAt: 123,
        displayName: 'Improve Dashboard'
      })
      store.getWorktreeMeta.mockImplementation((worktreeId: string) =>
        worktreeId === 'repo-1::C:/workspaces/improve-dashboard'
          ? {
              lastActivityAt: 123,
              displayName: 'Improve Dashboard'
            }
          : undefined
      )

      await handlers['worktrees:create'](null, {
        repoId: 'repo-1',
        name: 'Improve Dashboard'
      })
      const listed = await handlers['worktrees:list'](null, {
        repoId: 'repo-1'
      })

      expect(listed).toMatchObject([
        {
          id: 'repo-1::C:/workspaces/improve-dashboard',
          displayName: 'Improve Dashboard',
          lastActivityAt: 123
        }
      ])
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform
      })
    }
  })
})
