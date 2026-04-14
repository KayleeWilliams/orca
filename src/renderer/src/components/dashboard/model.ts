import { buildAgentStatusHoverRows } from '@/components/sidebar/AgentStatusHover'
import { formatAgentTypeLabel, isExplicitAgentStatusFresh } from '@/lib/agent-status'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { Repo, TerminalTab, Worktree } from '../../../../shared/types'

export type DashboardRow = ReturnType<typeof buildAgentStatusHoverRows>[number]

export type WorktreeGroup = {
  worktree: Worktree
  rows: DashboardRow[]
}

export type RepoGroup = {
  repo: Repo
  worktrees: WorktreeGroup[]
}

function isAgentRow(row: DashboardRow): boolean {
  return row.kind === 'explicit' || row.agentType !== 'unknown' || row.heuristicState !== null
}

function compareRows(a: DashboardRow, b: DashboardRow): number {
  return b.sortTimestamp - a.sortTimestamp
}

export function getRowState(
  row: DashboardRow,
  now: number
): {
  label: string
  className: string
  dotClassName: string
} {
  if (row.kind === 'explicit') {
    const isFresh = isExplicitAgentStatusFresh(row.explicit, now, AGENT_STATUS_STALE_AFTER_MS)
    const state =
      !isFresh && row.heuristicState
        ? row.heuristicState
        : row.explicit.state === 'blocked'
          ? 'waiting'
          : row.explicit.state

    if (state === 'working') {
      return {
        label: 'Working',
        className: 'bg-emerald-500/12 text-emerald-700',
        dotClassName: 'bg-emerald-500'
      }
    }
    if (state === 'waiting' || state === 'permission') {
      return {
        label: 'Waiting',
        className: 'bg-amber-500/14 text-amber-700',
        dotClassName: 'bg-amber-500'
      }
    }
    return {
      label: 'Done',
      className: 'bg-zinc-500/12 text-zinc-700',
      dotClassName: 'bg-zinc-500'
    }
  }

  if (row.heuristicState === 'working') {
    return {
      label: 'Working',
      className: 'bg-emerald-500/12 text-emerald-700',
      dotClassName: 'bg-emerald-500/70'
    }
  }
  if (row.heuristicState === 'permission') {
    return {
      label: 'Waiting',
      className: 'bg-amber-500/14 text-amber-700',
      dotClassName: 'bg-amber-500/70'
    }
  }
  return {
    label: 'Idle',
    className: 'bg-zinc-500/12 text-zinc-700',
    dotClassName: 'bg-zinc-400/60'
  }
}

export function buildRepoGroups(
  repos: Repo[],
  worktreesByRepo: Record<string, Worktree[]>,
  tabsByWorktree: Record<string, TerminalTab[]>,
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  now: number
): RepoGroup[] {
  return repos
    .map((repo) => {
      const worktrees =
        (worktreesByRepo[repo.id] ?? [])
          .map((worktree) => {
            const rows = buildAgentStatusHoverRows(
              tabsByWorktree[worktree.id] ?? [],
              agentStatusByPaneKey,
              now
            )
              .filter(isAgentRow)
              .sort(compareRows)

            // Why: the dashboard is also a global navigation surface. Keeping
            // worktrees visible even with zero detected agents avoids a blank
            // screen between lifecycle events and lets users jump straight to a
            // dormant worktree from either the concentric or list view.
            return { worktree, rows }
          })
          .filter((value): value is WorktreeGroup => value !== null) ?? []

      return worktrees.length > 0 ? { repo, worktrees } : null
    })
    .filter((value): value is RepoGroup => value !== null)
}

export function formatWorktreeStateSummary(rows: DashboardRow[], now: number): string {
  if (rows.length === 0) {
    return 'no agents'
  }
  const waiting = rows.filter((row) => getRowState(row, now).label === 'Waiting').length
  const working = rows.filter((row) => getRowState(row, now).label === 'Working').length
  if (waiting > 0) {
    return `${waiting} waiting`
  }
  if (working > 0) {
    return `${working} working`
  }
  return `${rows.length} idle`
}

export function formatRowAgentLabel(row: DashboardRow): string {
  return formatAgentTypeLabel(row.agentType)
}
