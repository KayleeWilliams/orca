import { useState, useMemo } from 'react'
import type { DashboardRepoGroup, DashboardWorktreeCard } from './useDashboardData'

export type DashboardFilter = 'active' | 'all' | 'working' | 'blocked' | 'done'

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
    case 'working':
      return card.dominantState === 'working'
    case 'blocked':
      return card.dominantState === 'blocked'
    case 'done':
      return card.dominantState === 'done'
  }
}

/** Sort worktrees within each group by most recent agent activity (descending). */
function sortByActivity(worktrees: DashboardWorktreeCard[]): DashboardWorktreeCard[] {
  return [...worktrees].sort((a, b) => b.latestActivityAt - a.latestActivityAt)
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
  const [filter, setFilter] = useState<DashboardFilter>('active')

  const filteredGroups = useMemo(() => {
    const filtered = groups
      .map((group) => ({
        ...group,
        worktrees: sortByActivity(
          group.worktrees.filter((wt) => matchesFilter(wt, filter, checkedWorktreeIds))
        )
      }))
      .filter((group) => group.worktrees.length > 0)

    // Sort repo groups by their most active worktree
    return filtered.sort((a, b) => {
      const aMax = a.worktrees[0]?.latestActivityAt ?? 0
      const bMax = b.worktrees[0]?.latestActivityAt ?? 0
      return bMax - aMax
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
