/* eslint-disable max-lines -- Why: eligibility, conflict, apply, and dismiss cases share the same mocked git/agent contract, so keeping the matrix together makes the branch-suggestion behavior easier to audit. */
import { EventEmitter } from 'events'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { BranchNameSuggestionState, Repo, WorktreeMeta } from '../shared/types'
import type { Store } from './persistence'
import { gitExecFileAsync } from './git/runner'
import { getBranchConflictKind } from './git/repo'
import { spawn } from 'child_process'
import {
  applyBranchNameSuggestion,
  dismissBranchNameSuggestion,
  maybeSuggestBranchNameAfterAgentDone
} from './branch-name-suggestions'

vi.mock('./git/runner', () => ({
  gitExecFileAsync: vi.fn()
}))

vi.mock('./git/repo', () => ({
  getBranchConflictKind: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: vi.fn()
}))

type GitResult = { stdout: string; stderr: string }

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'repo',
    badgeColor: '#123456',
    addedAt: 1,
    ...overrides
  }
}

function makeSuggestion(
  overrides: Partial<BranchNameSuggestionState> = {}
): BranchNameSuggestionState {
  return {
    status: 'idle',
    originalBranch: 'kaylee/original-name',
    baseRef: 'origin/main',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeMeta(suggestion: BranchNameSuggestionState): WorktreeMeta {
  return {
    displayName: '',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1,
    branchNameSuggestion: suggestion
  }
}

function makeStore(
  meta: WorktreeMeta | undefined,
  repo: Repo = makeRepo(),
  settings: { experimentalBranchNameSuggestions: boolean } = {
    experimentalBranchNameSuggestions: true
  }
): Store {
  return {
    getSettings: () => settings,
    getRepo: (repoId: string) => (repoId === repo.id ? repo : undefined),
    getWorktreeMeta: () => meta,
    setWorktreeMeta: (_worktreeId: string, updates: Partial<WorktreeMeta>) => {
      if (!meta) {
        throw new Error('unexpected metadata write')
      }
      Object.assign(meta, updates)
      return meta
    }
  } as unknown as Store
}

function mockGit(handler: (args: string[]) => GitResult | Promise<GitResult>): void {
  vi.mocked(gitExecFileAsync).mockImplementation(async (args) => handler(args))
}

function mockAgentOutput(output: string): void {
  vi.mocked(spawn).mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      stdin: { end: (input: string) => void }
      kill: () => void
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = {
      end: () => {
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from(output))
          child.emit('close', 0)
        })
      }
    }
    child.kill = vi.fn()
    return child as never
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getBranchConflictKind).mockResolvedValue(null)
})

describe('branch name suggestions', () => {
  it('does nothing when the experimental setting is disabled', async () => {
    const meta = makeMeta(makeSuggestion())
    const store = makeStore(meta, makeRepo(), { experimentalBranchNameSuggestions: false })

    const result = await maybeSuggestBranchNameAfterAgentDone({
      store,
      worktreeId: 'repo-1::/repo/wt',
      agentType: 'codex',
      onWorktreesChanged: vi.fn()
    })

    expect(result).toEqual({ ok: false, reason: 'disabled' })
    expect(gitExecFileAsync).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(meta.branchNameSuggestion?.status).toBe('idle')
  })

  it('does not make existing worktrees eligible without Orca creation metadata', async () => {
    const store = makeStore(undefined)

    const result = await maybeSuggestBranchNameAfterAgentDone({
      store,
      worktreeId: 'repo-1::/repo/wt',
      agentType: 'codex',
      onWorktreesChanged: vi.fn()
    })

    expect(result).toEqual({ ok: false, repoId: 'repo-1', reason: 'not-eligible' })
    expect(gitExecFileAsync).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('ignores unsupported agents before touching git', async () => {
    const meta = makeMeta(makeSuggestion())
    const store = makeStore(meta)

    const result = await maybeSuggestBranchNameAfterAgentDone({
      store,
      worktreeId: 'repo-1::/repo/wt',
      agentType: 'cursor',
      onWorktreesChanged: vi.fn()
    })

    expect(result).toEqual({ ok: false, reason: 'unsupported-agent' })
    expect(gitExecFileAsync).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(meta.branchNameSuggestion?.status).toBe('idle')
  })

  it('skips SSH repos rather than running a local agent against remote code', async () => {
    const meta = makeMeta(makeSuggestion())
    const store = makeStore(meta, makeRepo({ connectionId: 'ssh-1' }))

    const result = await maybeSuggestBranchNameAfterAgentDone({
      store,
      worktreeId: 'repo-1::/remote/wt',
      agentType: 'codex',
      onWorktreesChanged: vi.fn()
    })

    expect(result).toEqual({ ok: false, repoId: 'repo-1', reason: 'unsupported-repo' })
    expect(gitExecFileAsync).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(meta.branchNameSuggestion?.status).toBe('idle')
  })

  it('marks changed branches as skipped', async () => {
    const meta = makeMeta(makeSuggestion())
    const store = makeStore(meta)
    const onWorktreesChanged = vi.fn()
    mockGit((args) => {
      if (args[0] === 'branch') {
        return { stdout: 'kaylee/renamed-by-user\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await maybeSuggestBranchNameAfterAgentDone({
      store,
      worktreeId: 'repo-1::/repo/wt',
      agentType: 'gemini',
      onWorktreesChanged
    })

    expect(result).toEqual({ ok: false, repoId: 'repo-1', reason: 'branch-changed' })
    expect(meta.branchNameSuggestion).toMatchObject({
      status: 'skipped',
      failureReason: 'branch changed before suggestion'
    })
    expect(onWorktreesChanged).toHaveBeenCalledWith('repo-1')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('does not run an agent when the branch has no commits since its base', async () => {
    const meta = makeMeta(makeSuggestion())
    const store = makeStore(meta)
    mockGit((args) => {
      if (args[0] === 'branch') {
        return { stdout: 'kaylee/original-name\n', stderr: '' }
      }
      if (args[0] === 'rev-parse') {
        throw new Error('no upstream')
      }
      if (args[0] === 'for-each-ref') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'rev-list') {
        return { stdout: '0\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await maybeSuggestBranchNameAfterAgentDone({
      store,
      worktreeId: 'repo-1::/repo/wt',
      agentType: 'codex',
      onWorktreesChanged: vi.fn()
    })

    expect(result).toEqual({ ok: false, repoId: 'repo-1', reason: 'no-commits' })
    expect(spawn).not.toHaveBeenCalled()
    expect(meta.branchNameSuggestion?.status).toBe('idle')
  })

  it('asks the same supported agent and preserves the original branch prefix', async () => {
    const meta = makeMeta(makeSuggestion())
    const store = makeStore(meta)
    const onWorktreesChanged = vi.fn()
    mockAgentOutput('better-branch-name\n')
    mockGit((args) => {
      if (args[0] === 'branch') {
        return { stdout: 'kaylee/original-name\n', stderr: '' }
      }
      if (args[0] === 'rev-parse') {
        throw new Error('no upstream')
      }
      if (args[0] === 'for-each-ref') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'rev-list') {
        return { stdout: '2\n', stderr: '' }
      }
      if (args[0] === 'log') {
        return { stdout: 'Add branch rename flow\n', stderr: '' }
      }
      if (args[0] === 'diff') {
        return { stdout: 'diff content\n', stderr: '' }
      }
      if (args[0] === 'check-ref-format') {
        return { stdout: '', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await maybeSuggestBranchNameAfterAgentDone({
      store,
      worktreeId: 'repo-1::/repo/wt',
      agentType: 'codex',
      onWorktreesChanged
    })

    expect(result).toEqual({ ok: true, repoId: 'repo-1' })
    expect(spawn).toHaveBeenCalledWith(
      'codex',
      expect.arrayContaining(['exec', expect.stringContaining('Suggest one concise git branch')]),
      expect.objectContaining({ cwd: '/repo/wt', shell: false })
    )
    expect(meta.branchNameSuggestion).toMatchObject({
      status: 'suggested',
      suggestedBranch: 'kaylee/better-branch-name',
      agentType: 'codex'
    })
    expect(onWorktreesChanged).toHaveBeenCalledWith('repo-1')
  })

  it('marks pushed branches as skipped so they are not renamed later', async () => {
    const meta = makeMeta(makeSuggestion())
    const store = makeStore(meta)
    mockGit((args) => {
      if (args[0] === 'branch') {
        return { stdout: 'kaylee/original-name\n', stderr: '' }
      }
      if (args[0] === 'rev-parse') {
        return { stdout: 'origin/kaylee/original-name\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await maybeSuggestBranchNameAfterAgentDone({
      store,
      worktreeId: 'repo-1::/repo/wt',
      agentType: 'claude',
      onWorktreesChanged: vi.fn()
    })

    expect(result).toEqual({ ok: false, repoId: 'repo-1', reason: 'already-pushed' })
    expect(meta.branchNameSuggestion).toMatchObject({
      status: 'skipped',
      failureReason: 'branch already has a remote'
    })
  })

  it('allows an upstream that only points at the stored base ref', async () => {
    const meta = makeMeta(makeSuggestion())
    const store = makeStore(meta)
    mockAgentOutput('better-branch-name\n')
    mockGit((args) => {
      if (args[0] === 'branch') {
        return { stdout: 'kaylee/original-name\n', stderr: '' }
      }
      if (args[0] === 'rev-parse') {
        return { stdout: 'origin/main\n', stderr: '' }
      }
      if (args[0] === 'for-each-ref') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'rev-list') {
        return { stdout: '1\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await maybeSuggestBranchNameAfterAgentDone({
      store,
      worktreeId: 'repo-1::/repo/wt',
      agentType: 'codex',
      onWorktreesChanged: vi.fn()
    })

    expect(result).toEqual({ ok: true, repoId: 'repo-1' })
    expect(meta.branchNameSuggestion).toMatchObject({
      status: 'suggested',
      suggestedBranch: 'kaylee/better-branch-name'
    })
  })

  it('treats a same-name remote branch as already pushed even without upstream', async () => {
    const meta = makeMeta(makeSuggestion())
    const store = makeStore(meta)
    mockGit((args) => {
      if (args[0] === 'branch') {
        return { stdout: 'kaylee/original-name\n', stderr: '' }
      }
      if (args[0] === 'rev-parse') {
        throw new Error('no upstream')
      }
      if (args[0] === 'for-each-ref') {
        return { stdout: 'refs/remotes/origin/kaylee/original-name\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await maybeSuggestBranchNameAfterAgentDone({
      store,
      worktreeId: 'repo-1::/repo/wt',
      agentType: 'opencode',
      onWorktreesChanged: vi.fn()
    })

    expect(result).toEqual({ ok: false, repoId: 'repo-1', reason: 'already-pushed' })
    expect(meta.branchNameSuggestion).toMatchObject({
      status: 'skipped',
      failureReason: 'branch already has a remote'
    })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('does not ask again after a suggestion has already been recorded', async () => {
    const meta = makeMeta(
      makeSuggestion({
        status: 'suggested',
        suggestedBranch: 'kaylee/better-branch-name'
      })
    )
    const store = makeStore(meta)

    const result = await maybeSuggestBranchNameAfterAgentDone({
      store,
      worktreeId: 'repo-1::/repo/wt',
      agentType: 'codex',
      onWorktreesChanged: vi.fn()
    })

    expect(result).toEqual({ ok: false, repoId: 'repo-1', reason: 'not-eligible' })
    expect(gitExecFileAsync).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('suffixes the candidate when the agent suggestion conflicts', async () => {
    const meta = makeMeta(makeSuggestion())
    const store = makeStore(meta)
    mockAgentOutput('better-branch-name\n')
    vi.mocked(getBranchConflictKind).mockImplementation(async (_worktreePath, branchName) =>
      branchName === 'kaylee/better-branch-name' ? 'local' : null
    )
    mockGit((args) => {
      if (args[0] === 'branch') {
        return { stdout: 'kaylee/original-name\n', stderr: '' }
      }
      if (args[0] === 'rev-parse') {
        throw new Error('no upstream')
      }
      if (args[0] === 'for-each-ref') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'rev-list') {
        return { stdout: '1\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await maybeSuggestBranchNameAfterAgentDone({
      store,
      worktreeId: 'repo-1::/repo/wt',
      agentType: 'claude',
      onWorktreesChanged: vi.fn()
    })

    expect(result).toEqual({ ok: true, repoId: 'repo-1' })
    expect(meta.branchNameSuggestion).toMatchObject({
      status: 'suggested',
      suggestedBranch: 'kaylee/better-branch-name-2'
    })
  })

  it('applies a suggested branch after rechecking the current branch and conflicts', async () => {
    const meta = makeMeta(
      makeSuggestion({
        status: 'suggested',
        suggestedBranch: 'kaylee/better-branch-name'
      })
    )
    meta.displayName = 'original-name'
    const store = makeStore(meta)
    const gitCalls: string[][] = []
    mockGit((args) => {
      gitCalls.push(args)
      if (args[0] === 'branch' && args[1] === '--show-current') {
        return { stdout: 'kaylee/original-name\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await applyBranchNameSuggestion({
      store,
      worktreeId: 'repo-1::/repo/wt'
    })

    expect(result).toEqual({ ok: true })
    expect(gitCalls).toContainEqual([
      'branch',
      '-m',
      'kaylee/original-name',
      'kaylee/better-branch-name'
    ])
    expect(meta.branchNameSuggestion).toMatchObject({ status: 'applied' })
    expect(meta.displayName).toBe('better-branch-name')
  })

  it('does not overwrite a custom display name when applying a suggestion', async () => {
    const meta = makeMeta(
      makeSuggestion({
        status: 'suggested',
        suggestedBranch: 'kaylee/better-branch-name'
      })
    )
    meta.displayName = 'Customer auth cleanup'
    const store = makeStore(meta)
    mockGit((args) => {
      if (args[0] === 'branch' && args[1] === '--show-current') {
        return { stdout: 'kaylee/original-name\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await applyBranchNameSuggestion({
      store,
      worktreeId: 'repo-1::/repo/original-name'
    })

    expect(result).toEqual({ ok: true })
    expect(meta.branchNameSuggestion).toMatchObject({ status: 'applied' })
    expect(meta.displayName).toBe('Customer auth cleanup')
  })

  it('dismisses a ready suggestion without touching git', () => {
    const meta = makeMeta(
      makeSuggestion({
        status: 'suggested',
        suggestedBranch: 'kaylee/better-branch-name'
      })
    )
    const store = makeStore(meta)

    dismissBranchNameSuggestion({ store, worktreeId: 'repo-1::/repo/wt' })

    expect(meta.branchNameSuggestion).toMatchObject({ status: 'dismissed' })
    expect(gitExecFileAsync).not.toHaveBeenCalled()
  })
})
