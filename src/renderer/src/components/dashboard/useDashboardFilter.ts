import { useState, useMemo } from 'react'
import type {
  DashboardRepoGroup,
  DashboardWorktreeCard,
  DashboardAgentRow
} from './useDashboardData'

export type DashboardFilter = 'active' | 'all' | 'blocked' | 'done'

// Why: filters apply to individual AGENTS, not worktrees. Previously we filtered
// by the worktree's dominantState, so a done agent stayed visible under the
// 'active' tab if a sibling agent in the same worktree was working — which
// defeats the point of the filter. Agent-level filtering keeps the worktree
// grouping intact but hides rows whose state doesn't match.
function matchesAgent(agent: DashboardAgentRow, filter: DashboardFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'active':
      return agent.state === 'working'
    case 'blocked':
      return agent.state === 'blocked' || agent.state === 'waiting'
    case 'done':
      return agent.state === 'done'
  }
}

// Why: search also matches per-agent — so a typo'd prompt in one agent doesn't
// drag its unrelated siblings into the visible set. Repo/worktree/branch hits
// still surface the whole worktree row (keep all its agents) because at that
// point the user is looking for the *worktree*, not a specific agent inside it.
function worktreeMetaMatches(card: DashboardWorktreeCard, q: string): boolean {
  if (card.repo.displayName.toLowerCase().includes(q)) {
    return true
  }
  if (card.worktree.displayName.toLowerCase().includes(q)) {
    return true
  }
  const branch = card.worktree.branch?.toLowerCase() ?? ''
  return branch.includes(q)
}

function agentMatchesSearch(agent: DashboardAgentRow, q: string): boolean {
  if (agent.entry.prompt?.toLowerCase().includes(q)) {
    return true
  }
  if (agent.entry.toolName?.toLowerCase().includes(q)) {
    return true
  }
  if (agent.entry.toolInput?.toLowerCase().includes(q)) {
    return true
  }
  if (agent.entry.lastAssistantMessage?.toLowerCase().includes(q)) {
    return true
  }
  return agent.agentType.toLowerCase().includes(q)
}

export function useDashboardFilter(
  groups: DashboardRepoGroup[],
  searchQuery: string
): {
  filter: DashboardFilter
  setFilter: (f: DashboardFilter) => void
  filteredWorktrees: DashboardWorktreeCard[]
  hasResults: boolean
} {
  const [filter, setFilter] = useState<DashboardFilter>('all')

  const filteredWorktrees = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const flat: DashboardWorktreeCard[] = []
    for (const group of groups) {
      for (const wt of group.worktrees) {
        const stateMatched = wt.agents.filter((a) => matchesAgent(a, filter))
        if (stateMatched.length === 0) {
          continue
        }
        const agents: DashboardAgentRow[] =
          q.length === 0 || worktreeMetaMatches(wt, q)
            ? stateMatched
            : stateMatched.filter((a) => agentMatchesSearch(a, q))
        // Why: drop worktrees whose agents are all filtered out — an empty
        // row would just be noise in the list.
        if (agents.length === 0) {
          continue
        }
        flat.push({ ...wt, agents })
      }
    }
    // Why: sort worktrees by earliest-started agent (ascending). Stable once
    // populated — a new agent starting in a different worktree doesn't
    // reshuffle this one while the user is reading.
    flat.sort((a, b) => a.earliestStartedAt - b.earliestStartedAt)
    return flat
  }, [groups, filter, searchQuery])

  const hasResults = filteredWorktrees.length > 0

  return {
    filter,
    setFilter,
    filteredWorktrees,
    hasResults
  }
}
