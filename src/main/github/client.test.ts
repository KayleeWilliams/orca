import { beforeEach, describe, expect, it, vi } from 'vitest'

const { resolvePRForBranchMock } = vi.hoisted(() => ({
  resolvePRForBranchMock: vi.fn()
}))

// Why: the resolver owns all the branch → PR mapping logic and is covered
// exhaustively in branch-pr-resolution.test.ts. This file keeps a boundary
// test that just verifies client.getPRForBranch delegates correctly.
vi.mock('./branch-pr-resolution', () => ({
  resolvePRForBranch: resolvePRForBranchMock
}))

import { getPRForBranch } from './client'

describe('getPRForBranch', () => {
  beforeEach(() => {
    resolvePRForBranchMock.mockReset()
  })

  it('delegates to resolvePRForBranch and returns its result', async () => {
    const pr = {
      number: 42,
      title: 'Test',
      state: 'open' as const,
      url: 'https://github.com/acme/widgets/pull/42',
      checksStatus: 'success' as const,
      updatedAt: '2026-03-28T00:00:00Z',
      mergeable: 'MERGEABLE' as const,
      headSha: 'head-oid'
    }
    resolvePRForBranchMock.mockResolvedValueOnce(pr)

    const result = await getPRForBranch('/repo-root', 'refs/heads/feature/test')

    expect(resolvePRForBranchMock).toHaveBeenCalledWith('/repo-root', 'refs/heads/feature/test')
    expect(result).toBe(pr)
  })

  it('propagates a null result from the resolver', async () => {
    resolvePRForBranchMock.mockResolvedValueOnce(null)

    const result = await getPRForBranch('/repo-root', 'no-pr-branch')

    expect(result).toBeNull()
  })
})
