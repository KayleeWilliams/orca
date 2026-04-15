import { useState, useRef, useMemo, useCallback, useEffect } from 'react'
import type {
  DashboardRepoGroup,
  DashboardAgentRow,
  DashboardWorktreeCard
} from './useDashboardData'

// Why: when an agent finishes or its terminal closes, the store cleans up the
// status entry and the agent vanishes from useDashboardData. This hook captures
// those disappearances and retains the agents as "done" so the user can see
// what finished. The retained entry persists until the user clicks the worktree
// (which navigates to the terminal and dismisses the retained agents).

type RetainedAgent = DashboardAgentRow & {
  worktreeId: string
}

export function useRetainedAgents(liveGroups: DashboardRepoGroup[]): {
  enrichedGroups: DashboardRepoGroup[]
  dismissWorktreeAgents: (worktreeId: string) => void
} {
  const [retained, setRetained] = useState<Map<string, RetainedAgent>>(new Map())
  const prevAgentsRef = useRef<Map<string, { row: DashboardAgentRow; worktreeId: string }>>(
    new Map()
  )
  // Why: retainedRef avoids including `retained` in the effect's dependency
  // array, which would cause an infinite loop (effect updates retained →
  // retained changes → effect runs again).
  const retainedRef = useRef(retained)
  retainedRef.current = retained

  useEffect(() => {
    // Build the current set of live agents from the fresh store data
    const current = new Map<string, { row: DashboardAgentRow; worktreeId: string }>()
    const existingWorktreeIds = new Set<string>()
    for (const group of liveGroups) {
      for (const wt of group.worktrees) {
        existingWorktreeIds.add(wt.worktree.id)
        for (const agent of wt.agents) {
          current.set(agent.paneKey, { row: agent, worktreeId: wt.worktree.id })
        }
      }
    }

    // Build a set of tab IDs that have live explicit (non-heuristic) agents.
    // Why: heuristic paneKeys are "heuristic:{tabId}"; explicit ones are
    // "{tabId}:{paneId}". When an agent starts reporting explicit status, the
    // heuristic row vanishes — but that's a promotion, not a completion. We
    // must not retain the heuristic entry as "done" when its tab still has a
    // live explicit agent.
    const tabsWithExplicitAgent = new Set<string>()
    for (const paneKey of current.keys()) {
      if (!paneKey.startsWith('heuristic:')) {
        tabsWithExplicitAgent.add(paneKey.split(':')[0])
      }
    }

    // Detect agents that were present last render but are gone now
    const disappeared: RetainedAgent[] = []
    for (const [paneKey, prev] of prevAgentsRef.current) {
      if (
        !current.has(paneKey) &&
        !retainedRef.current.has(paneKey) &&
        // Why: don't retain heuristic "idle" agents — they weren't doing
        // meaningful work, so showing them as "done" would be misleading.
        prev.row.state !== 'idle'
      ) {
        // Why: if a heuristic agent vanished because an explicit agent for the
        // same tab took over, that's not a completion — skip retention.
        if (paneKey.startsWith('heuristic:')) {
          const tabId = paneKey.slice('heuristic:'.length)
          if (tabsWithExplicitAgent.has(tabId)) {
            continue
          }
        }
        disappeared.push({ ...prev.row, worktreeId: prev.worktreeId })
      }
    }

    prevAgentsRef.current = current

    // Batch: add newly disappeared agents + prune stale retained entries.
    setRetained((prev) => {
      const next = new Map(prev)
      let changed = false

      for (const ra of disappeared) {
        next.set(ra.paneKey, ra)
        changed = true
      }

      for (const [key, ra] of next) {
        // Prune retained agents whose worktree was deleted
        if (!existingWorktreeIds.has(ra.worktreeId)) {
          next.delete(key)
          changed = true
          continue
        }
        // Why: if a retained heuristic agent's tab now has an explicit agent,
        // the heuristic was superseded — evict it. This handles the case where
        // the heuristic was retained before the explicit status arrived.
        if (key.startsWith('heuristic:')) {
          const tabId = key.slice('heuristic:'.length)
          if (tabsWithExplicitAgent.has(tabId)) {
            next.delete(key)
            changed = true
          }
        }
      }

      return changed ? next : prev
    })
  }, [liveGroups])

  // Merge retained agents back into the group hierarchy so both views
  // (list and concentric) see them as regular "done" agent rows.
  const enrichedGroups = useMemo((): DashboardRepoGroup[] => {
    if (retained.size === 0) {
      return liveGroups
    }

    // Index retained agents by worktree for fast lookup
    const byWorktree = new Map<string, RetainedAgent[]>()
    for (const ra of retained.values()) {
      const list = byWorktree.get(ra.worktreeId) ?? []
      list.push(ra)
      byWorktree.set(ra.worktreeId, list)
    }

    // Avoid duplicates: if a paneKey is both live and retained (transient
    // overlap during the effect → re-render cycle), the live version wins.
    const livePaneKeys = new Set<string>()
    for (const group of liveGroups) {
      for (const wt of group.worktrees) {
        for (const agent of wt.agents) {
          livePaneKeys.add(agent.paneKey)
        }
      }
    }

    return liveGroups.map((group) => {
      const worktrees = group.worktrees.map((wt) => {
        const retainedForWt = byWorktree
          .get(wt.worktree.id)
          ?.filter((ra) => !livePaneKeys.has(ra.paneKey))
        if (!retainedForWt?.length) {
          return wt
        }

        const retainedRows: DashboardAgentRow[] = retainedForWt.map((ra) => ({
          ...ra,
          state: 'done'
        }))

        const mergedAgents = [...wt.agents, ...retainedRows]
        return {
          ...wt,
          agents: mergedAgents,
          dominantState: computeDominant(mergedAgents),
          latestActivityAt: Math.max(
            wt.latestActivityAt,
            ...retainedForWt.map((ra) => ra.entry?.updatedAt ?? 0)
          )
        } satisfies DashboardWorktreeCard
      })

      const attentionCount = worktrees.reduce(
        (count, wt) =>
          count + wt.agents.filter((a) => a.state === 'blocked' || a.state === 'waiting').length,
        0
      )

      return { ...group, worktrees, attentionCount } satisfies DashboardRepoGroup
    })
  }, [liveGroups, retained])

  const dismissWorktreeAgents = useCallback((worktreeId: string) => {
    setRetained((prev) => {
      const next = new Map(prev)
      let changed = false
      for (const [key, ra] of next) {
        if (ra.worktreeId === worktreeId) {
          next.delete(key)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [])

  return { enrichedGroups, dismissWorktreeAgents }
}

function computeDominant(agents: DashboardAgentRow[]): DashboardWorktreeCard['dominantState'] {
  if (agents.length === 0) {
    return 'idle'
  }
  let hasWorking = false
  let hasDone = false
  for (const agent of agents) {
    if (agent.state === 'blocked' || agent.state === 'waiting') {
      return 'blocked'
    }
    if (agent.state === 'working') {
      hasWorking = true
    }
    if (agent.state === 'done') {
      hasDone = true
    }
  }
  if (hasWorking) {
    return 'working'
  }
  if (hasDone) {
    return 'done'
  }
  return 'idle'
}
