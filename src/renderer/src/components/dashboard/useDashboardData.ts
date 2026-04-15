import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { detectAgentStatusFromTitle, inferAgentTypeFromTitle } from '@/lib/agent-status'
import type { AgentStatusEntry, AgentType } from '../../../../shared/agent-status-types'
import type { Repo, Worktree, TerminalTab } from '../../../../shared/types'

// ─── Dashboard data types ─────────────────────────────────────────────────────

export type DashboardAgentRow = {
  paneKey: string
  entry: AgentStatusEntry | null
  tab: TerminalTab
  agentType: AgentType
  state: string
  source: 'agent' | 'heuristic'
}

export type DashboardWorktreeCard = {
  worktree: Worktree
  agents: DashboardAgentRow[]
  /** Highest-priority agent state for filtering.
   *  Priority: blocked > working > done > idle.
   *  `waiting` is folded into `blocked` — both are attention-needed states. */
  dominantState: 'working' | 'blocked' | 'done' | 'idle'
  /** Most recent agent updatedAt across all agents in this worktree.
   *  Used to sort the dashboard by most recent activity. 0 if no agents. */
  latestActivityAt: number
}

export type DashboardRepoGroup = {
  repo: Repo
  worktrees: DashboardWorktreeCard[]
  /** Count of agents in attention-needed states (blocked/waiting). */
  attentionCount: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function computeDominantState(agents: DashboardAgentRow[]): DashboardWorktreeCard['dominantState'] {
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

function buildAgentRowsForWorktree(
  worktreeId: string,
  tabsByWorktree: Record<string, TerminalTab[]>,
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
): DashboardAgentRow[] {
  const tabs = tabsByWorktree[worktreeId] ?? []
  const rows: DashboardAgentRow[] = []

  for (const tab of tabs) {
    // Find explicit status entries for panes within this tab
    const explicitEntries = Object.values(agentStatusByPaneKey).filter((entry) =>
      entry.paneKey.startsWith(`${tab.id}:`)
    )

    if (explicitEntries.length > 0) {
      // Why: an explicit agent status report is proof that a terminal is active,
      // even if ptyId hasn't been set yet (e.g. the PTY was spawned but the tab
      // metadata hasn't received the ptyId back from the main process yet).
      for (const entry of explicitEntries) {
        rows.push({
          paneKey: entry.paneKey,
          entry,
          tab,
          agentType: entry.agentType ?? inferAgentTypeFromTitle(entry.terminalTitle ?? tab.title),
          state: entry.state,
          source: 'agent'
        })
      }
    } else if (tab.ptyId) {
      // Heuristic fallback from terminal title — only for tabs with a known PTY
      const heuristicStatus = detectAgentStatusFromTitle(tab.title)
      if (heuristicStatus) {
        rows.push({
          paneKey: `heuristic:${tab.id}`,
          entry: null,
          tab,
          agentType: inferAgentTypeFromTitle(tab.title),
          // Map heuristic 'permission' to 'blocked' for dashboard consistency
          state: heuristicStatus === 'permission' ? 'blocked' : heuristicStatus,
          source: 'heuristic'
        })
      }
    }
  }

  return rows
}

function buildDashboardData(
  repos: Repo[],
  worktreesByRepo: Record<string, Worktree[]>,
  tabsByWorktree: Record<string, TerminalTab[]>,
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
): DashboardRepoGroup[] {
  return repos.map((repo) => {
    const worktrees = (worktreesByRepo[repo.id] ?? [])
      .filter((w) => !w.isArchived)
      .map((worktree) => {
        const agents = buildAgentRowsForWorktree(worktree.id, tabsByWorktree, agentStatusByPaneKey)
        let latestActivityAt = 0
        for (const agent of agents) {
          if (agent.entry && agent.entry.updatedAt > latestActivityAt) {
            latestActivityAt = agent.entry.updatedAt
          }
        }
        return {
          worktree,
          agents,
          dominantState: computeDominantState(agents),
          latestActivityAt
        } satisfies DashboardWorktreeCard
      })

    const attentionCount = worktrees.reduce(
      (count, wt) =>
        count + wt.agents.filter((a) => a.state === 'blocked' || a.state === 'waiting').length,
      0
    )

    return { repo, worktrees, attentionCount } satisfies DashboardRepoGroup
  })
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useDashboardData(): DashboardRepoGroup[] {
  const repos = useAppStore((s) => s.repos)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const agentStatusByPaneKey = useAppStore((s) => s.agentStatusByPaneKey)
  // Why: agentStatusEpoch is included in the dependency array (but not in the
  // computation itself) so the memo recomputes when freshness boundaries expire,
  // even if no new PTY data arrives.
  const agentStatusEpoch = useAppStore((s) => s.agentStatusEpoch)

  return useMemo(
    () => buildDashboardData(repos, worktreesByRepo, tabsByWorktree, agentStatusByPaneKey),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repos, worktreesByRepo, tabsByWorktree, agentStatusByPaneKey, agentStatusEpoch]
  )
}
