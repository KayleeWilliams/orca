import { describe, expect, it, vi } from 'vitest'
import { buildWorkspaceSessionPayload, shouldPersistWorkspaceSession } from './workspace-session'
import type { AppState } from '../store'

function createSnapshot(overrides: Partial<AppState> = {}): AppState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: 'wt-1',
    activeTabId: 'tab-1',
    tabsByWorktree: {
      'wt-1': [{ id: 'tab-1', title: 'shell', ptyId: 'pty-1', worktreeId: 'wt-1' }],
      'wt-2': [{ id: 'tab-2', title: 'editor', ptyId: null, worktreeId: 'wt-2' }]
    },
    terminalLayoutsByTabId: {
      'tab-1': { root: null, activeLeafId: null, expandedLeafId: null }
    },
    activeTabIdByWorktree: { 'wt-1': 'tab-1', 'wt-2': 'tab-2' },
    openFiles: [
      {
        filePath: '/tmp/demo.ts',
        relativePath: 'demo.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        mode: 'edit',
        isDirty: false,
        isPreview: false,
        content: '',
        originalContent: ''
      },
      {
        filePath: '/tmp/demo.diff',
        relativePath: 'demo.diff',
        worktreeId: 'wt-1',
        language: 'diff',
        mode: 'diff',
        isDirty: false,
        isPreview: false,
        content: '',
        originalContent: ''
      }
    ],
    activeFileIdByWorktree: { 'wt-1': '/tmp/demo.ts' },
    activeTabTypeByWorktree: { 'wt-1': 'editor', 'wt-2': 'terminal' },
    browserTabsByWorktree: {
      'wt-1': [
        {
          id: 'browser-1',
          url: 'https://example.com',
          title: 'Example',
          loading: true,
          canGoBack: false,
          canGoForward: false,
          errorCode: null,
          errorDescription: null
        }
      ]
    },
    activeBrowserTabIdByWorktree: { 'wt-1': 'browser-1' },
    lastKnownRelayPtyIdByTabId: {},
    sshConnectionStates: new Map(),
    repos: [],
    worktreesByRepo: {},
    browserPagesByWorkspace: {
      'browser-1': [
        {
          id: 'page-1',
          workspaceId: 'browser-1',
          worktreeId: 'wt-1',
          url: 'https://example.com',
          title: 'Example',
          loading: true,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: Date.now()
        }
      ]
    },
    ...overrides
  } as AppState
}

describe('buildWorkspaceSessionPayload', () => {
  it('preserves activeWorktreeIdsOnShutdown for full replacement writes', () => {
    const payload = buildWorkspaceSessionPayload(createSnapshot())

    expect(payload.activeWorktreeIdsOnShutdown).toEqual(['wt-1'])
  })

  it('persists only edit-mode files and resets browser loading state', () => {
    const payload = buildWorkspaceSessionPayload(createSnapshot())

    expect(payload.openFilesByWorktree).toEqual({
      'wt-1': [
        {
          filePath: '/tmp/demo.ts',
          relativePath: 'demo.ts',
          worktreeId: 'wt-1',
          language: 'typescript',
          isPreview: undefined
        }
      ]
    })
    expect(payload.browserTabsByWorktree?.['wt-1'][0].loading).toBe(false)
  })

  it('uses lastKnownRelayPtyIdByTabId fallback for SSH worktrees with null ptyIds', () => {
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', title: 'shell', ptyId: 'pty-1', worktreeId: 'wt-1' } as never],
          'wt-ssh': [{ id: 'tab-ssh', title: 'remote', ptyId: null, worktreeId: 'wt-ssh' } as never]
        },
        lastKnownRelayPtyIdByTabId: { 'tab-ssh': 'relay-sess-42' },
        repos: [{ id: 'repo-ssh', connectionId: 'conn-1' } as never],
        worktreesByRepo: {
          'repo-ssh': [{ id: 'wt-ssh', repoId: 'repo-ssh' } as never]
        },
        sshConnectionStates: new Map([
          ['conn-1', { status: 'connected', targetId: 'conn-1', error: null, reconnectAttempt: 0 }]
        ]) as never
      })
    )

    expect(payload.activeWorktreeIdsOnShutdown).toContain('wt-ssh')
    expect(payload.remoteSessionIdsByTabId).toEqual({ 'tab-ssh': 'relay-sess-42' })
    expect(payload.activeConnectionIdsAtShutdown).toEqual(['conn-1'])
  })

  it('drops transient active editor markers that do not point at restored edit files', () => {
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        activeFileIdByWorktree: { 'wt-1': '/tmp/demo.diff' },
        activeTabTypeByWorktree: { 'wt-1': 'editor', 'wt-2': 'terminal' }
      })
    )

    expect(payload.activeFileIdByWorktree).toEqual({})
    expect(payload.activeTabTypeByWorktree).toEqual({ 'wt-2': 'terminal' })
  })
})

describe('hydration-failure integration: writer stays gated (issue #1158)', () => {
  // Why: simulates the App.tsx subscribe pattern end-to-end — a store change
  // arrives AFTER a failed hydration, and we assert the writer is never
  // called. If the gate regresses, this test flips red before users do.
  function simulateWriterSubscription(
    getState: () => { workspaceSessionReady: boolean; hydrationSucceeded: boolean },
    writer: () => void
  ): (nextState: { workspaceSessionReady: boolean; hydrationSucceeded: boolean }) => void {
    return (nextState) => {
      // Mirror App.tsx: read from the store; if the gate says no, skip.
      const state = { ...getState(), ...nextState }
      if (!shouldPersistWorkspaceSession(state)) {
        return
      }
      writer()
    }
  }

  it('never invokes the writer when hydration failed mid-flight', () => {
    let hydrationSucceeded = false
    let workspaceSessionReady = false
    const writer = vi.fn()
    const notify = simulateWriterSubscription(
      () => ({ workspaceSessionReady, hydrationSucceeded }),
      writer
    )

    // Simulate App.tsx's error path: reconnectPersistedTerminals still flips
    // workspaceSessionReady=true so the UI can mount, but setHydrationSucceeded
    // is never called because the try block threw.
    workspaceSessionReady = true
    notify({ workspaceSessionReady, hydrationSucceeded })

    // Simulate a state change after failure (user types in a terminal, tab
    // gets created, etc). The writer MUST remain uncalled — otherwise the
    // empty in-memory session would overwrite the on-disk file.
    for (let i = 0; i < 10; i++) {
      notify({ workspaceSessionReady, hydrationSucceeded })
    }

    expect(writer).not.toHaveBeenCalled()
  })

  it('invokes the writer once hydration is marked successful', () => {
    let hydrationSucceeded = false
    let workspaceSessionReady = false
    const writer = vi.fn()
    const notify = simulateWriterSubscription(
      () => ({ workspaceSessionReady, hydrationSucceeded }),
      writer
    )

    workspaceSessionReady = true
    hydrationSucceeded = true
    notify({ workspaceSessionReady, hydrationSucceeded })

    expect(writer).toHaveBeenCalledTimes(1)
  })
})

describe('shouldPersistWorkspaceSession (issue #1158 gate)', () => {
  it('returns false before either flag is set', () => {
    expect(
      shouldPersistWorkspaceSession({
        workspaceSessionReady: false,
        hydrationSucceeded: false
      })
    ).toBe(false)
  })

  it('returns false when the UI is ready but hydration failed', () => {
    // The error path in App.tsx flips workspaceSessionReady=true so the UI can
    // mount, but leaves hydrationSucceeded=false. The writer must stay gated
    // so the empty in-memory state is never persisted.
    expect(
      shouldPersistWorkspaceSession({
        workspaceSessionReady: true,
        hydrationSucceeded: false
      })
    ).toBe(false)
  })

  it('returns false when hydration finished but UI isn’t ready yet', () => {
    expect(
      shouldPersistWorkspaceSession({
        workspaceSessionReady: false,
        hydrationSucceeded: true
      })
    ).toBe(false)
  })

  it('returns true only when both flags are set', () => {
    expect(
      shouldPersistWorkspaceSession({
        workspaceSessionReady: true,
        hydrationSucceeded: true
      })
    ).toBe(true)
  })
})
