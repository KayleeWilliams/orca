import { useState, useMemo } from 'react'
import type { DashboardRepoGroup, DashboardWorktreeCard } from './useDashboardData'

export type DashboardFilter = 'active' | 'all' | 'blocked' | 'done'

// Why: every filter requires agents — the dashboard is an agent activity view,
// not a worktree list. Worktrees with zero agents are never shown regardless
// of which filter is selected.
function hasAgents(card: DashboardWorktreeCard): boolean {
  return card.agents.length > 0
}

// Why: the 'active' filter is the smart default — it only shows worktrees
// that need the user's attention (running agents, blocked agents, or agents
// that finished but the user hasn't navigated to yet). This prevents the
// dashboard from being a noisy mirror of the worktree list.
function matchesFilter(
  card: DashboardWorktreeCard,
  filter: DashboardFilter,
  checkedWorktreeIds: Set<string>
): boolean {
  if (!hasAgents(card)) {
    return false
  }
  switch (filter) {
    case 'all':
      return true
    case 'active':
      if (card.dominantState === 'working' || card.dominantState === 'blocked') {
        return true
      }
      if (card.dominantState === 'done' && !checkedWorktreeIds.has(card.worktree.id)) {
        return true
      }
      return false
    case 'blocked':
      return card.dominantState === 'blocked'
    case 'done':
      return card.dominantState === 'done'
  }
}

/** Sort worktrees by earliest-started agent (ascending). Stable once populated
 *  — new agents starting in a different worktree don't reshuffle this one. */
function sortByStartTime(worktrees: DashboardWorktreeCard[]): DashboardWorktreeCard[] {
  return [...worktrees].sort((a, b) => a.earliestStartedAt - b.earliestStartedAt)
}

export function useDashboardFilter(
  groups: DashboardRepoGroup[],
  checkedWorktreeIds: Set<string>
): {
  filter: DashboardFilter
  setFilter: (f: DashboardFilter) => void
  filteredGroups: DashboardRepoGroup[]
  hasResults: boolean
} {
  const [filter, setFilter] = useState<DashboardFilter>('all')

  const filteredGroups = useMemo(() => {
    const filtered = groups
      .map((group) => ({
        ...group,
        worktrees: sortByStartTime(
          group.worktrees.filter((wt) => matchesFilter(wt, filter, checkedWorktreeIds))
        )
      }))
      .filter((group) => group.worktrees.length > 0)

    // Why: sort repo groups by their earliest-started worktree, ascending.
    // The first worktree after sortByStartTime is the oldest, so using its
    // earliestStartedAt as the group key keeps repos stable on screen once
    // populated — new agent activity in another repo doesn't reshuffle the
    // list while the user reads.
    return filtered.sort((a, b) => {
      const aKey = a.worktrees[0]?.earliestStartedAt ?? 0
      const bKey = b.worktrees[0]?.earliestStartedAt ?? 0
      return aKey - bKey
    })
  }, [groups, filter, checkedWorktreeIds])

  const hasResults = filteredGroups.some((g) => g.worktrees.length > 0)

  return {
    filter,
    setFilter,
    filteredGroups,
    hasResults
  }
}
