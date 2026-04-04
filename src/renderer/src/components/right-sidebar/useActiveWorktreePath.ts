import { useMemo } from 'react'
import type { Worktree } from '../../../../shared/types'

/**
 * Resolves the on-disk path for the currently active worktree.
 */
export function useActiveWorktreePath(
  activeWorktreeId: string | null,
  worktreesByRepo: Record<string, Worktree[]>
): string | null {
  return useMemo(() => {
    if (!activeWorktreeId) {
      return null
    }
    for (const worktrees of Object.values(worktreesByRepo)) {
      const wt = worktrees.find((w) => w.id === activeWorktreeId)
      if (wt) {
        return wt.path
      }
    }
    return null
  }, [activeWorktreeId, worktreesByRepo])
}
