import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

import { getPRConflictSummary } from './conflict-summary'

describe('getPRConflictSummary', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
  })

  it('derives a read-only conflict summary when the base ref exists locally', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' }) // fetch
      .mockResolvedValueOnce({ stdout: 'latest-base-oid\n' }) // rev-parse refs/remotes/origin/main
      .mockResolvedValueOnce({ stdout: 'merge-base-oid\n' }) // merge-base
      .mockResolvedValueOnce({ stdout: '3\n' }) // rev-list --count
      .mockResolvedValueOnce({ stdout: 'result-tree-oid\0src/a.ts\0src/b.ts\0' }) // merge-tree

    const result = await getPRConflictSummary('/repo-root', 'main', 'base-oid', 'head-oid')

    expect(result).toEqual({
      baseRef: 'main',
      baseCommit: 'latest-',
      commitsBehind: 3,
      files: ['src/a.ts', 'src/b.ts']
    })
  })

  it('keeps conflicted file paths when git merge-tree exits 1 with stdout', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' }) // fetch
      .mockResolvedValueOnce({ stdout: 'latest-base-oid\n' }) // rev-parse refs/remotes/origin/main
      .mockResolvedValueOnce({ stdout: 'merge-base-oid\n' }) // merge-base
      .mockResolvedValueOnce({ stdout: '3\n' }) // rev-list --count
      .mockRejectedValueOnce({ stdout: 'result-tree-oid\0src/conflict.ts\0' }) // merge-tree exit 1

    const result = await getPRConflictSummary('/repo-root', 'main', 'base-oid', 'head-oid')

    expect(result?.files).toEqual(['src/conflict.ts'])
  })

  it('falls back to GitHub baseRefOid when fetching or resolving the base ref fails', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('fetch failed')) // fetch
      .mockRejectedValueOnce(new Error('missing refs/remotes/origin/main')) // first rev-parse
      .mockRejectedValueOnce(new Error('missing origin/main')) // second rev-parse
      .mockResolvedValueOnce({ stdout: 'merge-base-oid\n' }) // merge-base
      .mockResolvedValueOnce({ stdout: '1\n' }) // rev-list --count
      .mockResolvedValueOnce({ stdout: 'result-tree-oid\0src/fallback.ts\0' }) // merge-tree

    const result = await getPRConflictSummary('/repo-root', 'main', 'base-oid', 'head-oid')

    expect(result).toEqual({
      baseRef: 'main',
      baseCommit: 'base-oi',
      commitsBehind: 1,
      files: ['src/fallback.ts']
    })
  })
})
