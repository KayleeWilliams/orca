/* eslint-disable max-lines -- Why: exhaustive coverage of the branch → PR
resolver cascade keeps the fixtures for each stage (upstream-name, SHA fallback,
validation rejections, boundary/misc) adjacent so a future maintainer can audit
the full matrix without jumping files. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  ghExecFileAsyncMock,
  gitExecFileAsyncMock,
  getOwnerRepoMock,
  acquireMock,
  releaseMock,
  getPRConflictSummaryMock
} = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn(),
  getOwnerRepoMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn(),
  getPRConflictSummaryMock: vi.fn()
}))

vi.mock('./gh-utils', () => ({
  ghExecFileAsync: ghExecFileAsyncMock,
  getOwnerRepo: getOwnerRepoMock,
  acquire: acquireMock,
  release: releaseMock
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('./conflict-summary', () => ({
  getPRConflictSummary: getPRConflictSummaryMock
}))

import { resolvePRForBranch } from './branch-pr-resolution'

const PR_JSON_FIELDS =
  'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,baseRefName,headRefName,baseRefOid,headRefOid'

function makeRawPR(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 42,
    title: 'Test PR',
    state: 'OPEN',
    url: 'https://github.com/acme/widgets/pull/42',
    statusCheckRollup: [],
    updatedAt: '2026-03-28T00:00:00Z',
    isDraft: false,
    mergeable: 'MERGEABLE',
    baseRefName: 'main',
    headRefName: 'feature/test',
    baseRefOid: 'base-oid',
    headRefOid: 'head-oid',
    ...overrides
  }
}

describe('resolvePRForBranch', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
    acquireMock.mockReset()
    releaseMock.mockReset()
    getPRConflictSummaryMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    getPRConflictSummaryMock.mockResolvedValue(undefined)
  })

  describe('stage 1 — upstream-aware name lookup', () => {
    it('resolves via upstream when local and remote names match, skipping stage 2', async () => {
      getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
      gitExecFileAsyncMock.mockResolvedValueOnce({
        stdout: 'refs/remotes/origin/feature/test\n'
      })
      ghExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify([makeRawPR()])
      })

      const pr = await resolvePRForBranch('/repo', 'refs/heads/feature/test')

      expect(pr?.number).toBe(42)
      expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
      expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
        ['rev-parse', '--symbolic-full-name', 'feature/test@{upstream}'],
        { cwd: '/repo' }
      )
      expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
      expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
        [
          'pr',
          'list',
          '--repo',
          'acme/widgets',
          '--head',
          'feature/test',
          '--state',
          'all',
          '--limit',
          '1',
          '--json',
          PR_JSON_FIELDS
        ],
        { cwd: '/repo' }
      )
    })

    it('resolves via upstream when upstream branch name differs from local branch', async () => {
      getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
      gitExecFileAsyncMock.mockResolvedValueOnce({
        stdout: 'refs/remotes/origin/user/fix-thing\n'
      })
      ghExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify([makeRawPR({ number: 733, headRefName: 'user/fix-thing' })])
      })

      const pr = await resolvePRForBranch('/repo', 'fix-thing')

      expect(pr?.number).toBe(733)
      expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
        expect.arrayContaining(['--head', 'user/fix-thing']),
        { cwd: '/repo' }
      )
    })

    it('handles non-origin remotes correctly when stripping the remote prefix', async () => {
      getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
      gitExecFileAsyncMock.mockResolvedValueOnce({
        stdout: 'refs/remotes/fork/feature-x\n'
      })
      ghExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify([makeRawPR({ headRefName: 'feature-x' })])
      })

      const pr = await resolvePRForBranch('/repo', 'feature-x')

      expect(pr?.number).toBe(42)
      expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
        expect.arrayContaining(['--head', 'feature-x']),
        { cwd: '/repo' }
      )
    })

    it('falls through when upstream points at refs/heads/* (local ref)', async () => {
      getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
      gitExecFileAsyncMock
        .mockResolvedValueOnce({ stdout: 'refs/heads/main\n' }) // upstream resolves to local
        .mockResolvedValueOnce({ stdout: 'abc1234567890\n' }) // rev-parse HEAD
      ghExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify([makeRawPR({ headRefOid: 'abc1234567890' })])
      })

      const pr = await resolvePRForBranch('/repo', 'topic')

      expect(pr?.number).toBe(42)
      // Stage 1 never invoked gh (upstream was rejected), stage 2 did.
      expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
      expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
        expect.arrayContaining(['--search', 'abc1234567890 is:pr']),
        { cwd: '/repo' }
      )
    })

    it('falls through to stage 2 when gh pr list returns an empty array', async () => {
      getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
      gitExecFileAsyncMock
        .mockResolvedValueOnce({ stdout: 'refs/remotes/origin/feature/test\n' })
        .mockResolvedValueOnce({ stdout: 'head-sha\n' })
      ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' }).mockResolvedValueOnce({
        stdout: JSON.stringify([makeRawPR({ headRefOid: 'head-sha' })])
      })

      const pr = await resolvePRForBranch('/repo', 'feature/test')

      expect(pr?.number).toBe(42)
      expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    })

    it('falls through to stage 2 when stage 1 gh errors transiently', async () => {
      getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
      gitExecFileAsyncMock
        .mockResolvedValueOnce({ stdout: 'refs/remotes/origin/feature/test\n' })
        .mockResolvedValueOnce({ stdout: 'head-sha\n' })
      ghExecFileAsyncMock.mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce({
        stdout: JSON.stringify([makeRawPR({ headRefOid: 'head-sha' })])
      })

      const pr = await resolvePRForBranch('/repo', 'feature/test')

      expect(pr?.number).toBe(42)
    })

    it('releases the gh lock on stage 1 error', async () => {
      getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
      gitExecFileAsyncMock
        .mockResolvedValueOnce({ stdout: 'refs/remotes/origin/feature/test\n' })
        .mockRejectedValueOnce(new Error('rev-parse HEAD failed'))
      ghExecFileAsyncMock.mockRejectedValueOnce(new Error('boom'))

      await resolvePRForBranch('/repo', 'feature/test')

      expect(acquireMock).toHaveBeenCalledTimes(1)
      expect(releaseMock).toHaveBeenCalledTimes(1)
    })
  })

  describe('stage 2 — HEAD-SHA fallback', () => {
    it('resolves by SHA when upstream is unconfigured', async () => {
      getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
      gitExecFileAsyncMock
        .mockRejectedValueOnce(new Error('no upstream configured'))
        .mockResolvedValueOnce({ stdout: 'deadbeefcafe\n' })
      ghExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify([makeRawPR({ headRefOid: 'deadbeefcafe', number: 733 })])
      })

      const pr = await resolvePRForBranch('/repo', 'fix-pr-check-node-gyp-perms')

      expect(pr?.number).toBe(733)
      expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
        [
          'pr',
          'list',
          '--repo',
          'acme/widgets',
          '--search',
          'deadbeefcafe is:pr',
          '--state',
          'all',
          '--limit',
          '100',
          '--json',
          PR_JSON_FIELDS
        ],
        { cwd: '/repo' }
      )
    })

    it('rejects a search match whose headRefOid differs from HEAD (stale/recycled PR)', async () => {
      getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
      gitExecFileAsyncMock
        .mockRejectedValueOnce(new Error('no upstream'))
        .mockResolvedValueOnce({ stdout: 'new-sha\n' })
      ghExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify([makeRawPR({ headRefOid: 'old-stale-sha', state: 'MERGED' })])
      })

      const pr = await resolvePRForBranch('/repo', 'recycled-branch')

      expect(pr).toBeNull()
    })

    it('picks the candidate with matching headRefOid when search returns multiple', async () => {
      getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
      gitExecFileAsyncMock
        .mockRejectedValueOnce(new Error('no upstream'))
        .mockResolvedValueOnce({ stdout: 'my-sha\n' })
      ghExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify([
          makeRawPR({ number: 100, headRefOid: 'other-sha' }),
          makeRawPR({ number: 200, headRefOid: 'my-sha' })
        ])
      })

      const pr = await resolvePRForBranch('/repo', 'branch')

      expect(pr?.number).toBe(200)
    })

    it('returns null when stage 1 errors and stage 2 search returns empty', async () => {
      getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
      gitExecFileAsyncMock
        .mockRejectedValueOnce(new Error('no upstream'))
        .mockResolvedValueOnce({ stdout: 'some-sha\n' })
      ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' })

      const pr = await resolvePRForBranch('/repo', 'unpublished')

      expect(pr).toBeNull()
    })

    // Why: design doc §"Edge cases" item 3 — upstream is configured (stage 1
    // runs a real gh pr list query) but no PR exists yet, so stage 1 returns
    // []. Stage 2 must still run as a fallback (the branch could have been
    // pushed under a different name) and also come back empty, at which point
    // we return null rather than surfacing a stale or unrelated PR.
    it('returns null when upstream is set but both stages return empty', async () => {
      getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
      gitExecFileAsyncMock
        .mockResolvedValueOnce({ stdout: 'refs/remotes/origin/feature/test\n' })
        .mockResolvedValueOnce({ stdout: 'head-sha\n' })
      ghExecFileAsyncMock
        .mockResolvedValueOnce({ stdout: '[]' })
        .mockResolvedValueOnce({ stdout: '[]' })

      const pr = await resolvePRForBranch('/repo', 'feature/test')

      expect(pr).toBeNull()
      expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    })

    it('returns null when rev-parse HEAD fails', async () => {
      getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
      gitExecFileAsyncMock
        .mockRejectedValueOnce(new Error('no upstream'))
        .mockRejectedValueOnce(new Error('rev-parse HEAD failed'))

      const pr = await resolvePRForBranch('/repo', 'branch')

      expect(pr).toBeNull()
      expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
    })

    it('returns null when gh search errors', async () => {
      getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
      gitExecFileAsyncMock
        .mockRejectedValueOnce(new Error('no upstream'))
        .mockResolvedValueOnce({ stdout: 'head-sha\n' })
      ghExecFileAsyncMock.mockRejectedValueOnce(new Error('rate limit'))

      const pr = await resolvePRForBranch('/repo', 'branch')

      expect(pr).toBeNull()
    })
  })

  describe('boundary / misc', () => {
    it('returns null on empty branch name (detached HEAD during rebase)', async () => {
      const pr = await resolvePRForBranch('/repo', '')

      expect(pr).toBeNull()
      expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
      expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    })

    it('returns null for refs/heads/ only branch (empty after strip)', async () => {
      const pr = await resolvePRForBranch('/repo', 'refs/heads/')

      expect(pr).toBeNull()
      expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
    })

    it('strips refs/heads/ prefix before passing to @{upstream}', async () => {
      getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
      gitExecFileAsyncMock.mockResolvedValueOnce({
        stdout: 'refs/remotes/origin/feature/test\n'
      })
      ghExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify([makeRawPR()])
      })

      await resolvePRForBranch('/repo', 'refs/heads/feature/test')

      expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
        ['rev-parse', '--symbolic-full-name', 'feature/test@{upstream}'],
        { cwd: '/repo' }
      )
    })

    it('falls back to gh pr view when the remote is not a recognizable GitHub repo', async () => {
      getOwnerRepoMock.mockResolvedValue(null)
      ghExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify(makeRawPR({ number: 7, isDraft: true }))
      })

      const pr = await resolvePRForBranch('/non-github', 'feature/test')

      expect(pr?.number).toBe(7)
      expect(pr?.state).toBe('draft')
      expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
        ['pr', 'view', 'feature/test', '--json', PR_JSON_FIELDS],
        { cwd: '/non-github' }
      )
      // Never tried stage 1 / 2 cascade — no git invocations.
      expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    })

    it('attaches a conflict summary when the matched PR is CONFLICTING', async () => {
      getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
      gitExecFileAsyncMock.mockResolvedValueOnce({
        stdout: 'refs/remotes/origin/feature/test\n'
      })
      ghExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify([makeRawPR({ mergeable: 'CONFLICTING' })])
      })
      getPRConflictSummaryMock.mockResolvedValueOnce({
        baseRef: 'main',
        baseCommit: 'abc1234',
        commitsBehind: 2,
        files: ['a.ts']
      })

      const pr = await resolvePRForBranch('/repo', 'feature/test')

      expect(pr?.mergeable).toBe('CONFLICTING')
      expect(pr?.conflictSummary).toEqual({
        baseRef: 'main',
        baseCommit: 'abc1234',
        commitsBehind: 2,
        files: ['a.ts']
      })
    })
  })
})
