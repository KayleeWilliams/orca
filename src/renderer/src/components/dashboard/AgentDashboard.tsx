import React, { useMemo } from 'react'
import { ChevronRight, Bot } from 'lucide-react'
import { useAppStore } from '@/store'
import { buildAgentStatusHoverRows } from '@/components/sidebar/AgentStatusHover'
import { formatAgentTypeLabel, isExplicitAgentStatusFresh } from '@/lib/agent-status'
import { cn } from '@/lib/utils'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import type { Repo, TerminalTab, Worktree } from '../../../../shared/types'

type DashboardRow = ReturnType<typeof buildAgentStatusHoverRows>[number]

type WorktreeGroup = {
  worktree: Worktree
  rows: DashboardRow[]
}

type RepoGroup = {
  repo: Repo
  worktrees: WorktreeGroup[]
}

function isAgentRow(row: DashboardRow): boolean {
  return row.kind === 'explicit' || row.agentType !== 'unknown' || row.heuristicState !== null
}

function compareRows(a: DashboardRow, b: DashboardRow): number {
  return b.sortTimestamp - a.sortTimestamp
}

function getRowState(
  row: DashboardRow,
  now: number
): {
  label: string
  className: string
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
      return { label: 'Working', className: 'bg-emerald-500/12 text-emerald-700' }
    }
    if (state === 'waiting' || state === 'permission') {
      return { label: 'Waiting', className: 'bg-amber-500/14 text-amber-700' }
    }
    return { label: 'Done', className: 'bg-zinc-500/12 text-zinc-700' }
  }

  if (row.heuristicState === 'working') {
    return { label: 'Working', className: 'bg-emerald-500/12 text-emerald-700' }
  }
  if (row.heuristicState === 'permission') {
    return { label: 'Waiting', className: 'bg-amber-500/14 text-amber-700' }
  }
  return { label: 'Idle', className: 'bg-zinc-500/12 text-zinc-700' }
}

function buildRepoGroups(
  repos: Repo[],
  worktreesByRepo: Record<string, Worktree[]>,
  tabsByWorktree: Record<string, TerminalTab[]>,
  agentStatusByPaneKey: ReturnType<typeof useAppStore.getState>['agentStatusByPaneKey'],
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

            return rows.length > 0 ? { worktree, rows } : null
          })
          .filter((value): value is WorktreeGroup => value !== null) ?? []

      return worktrees.length > 0 ? { repo, worktrees } : null
    })
    .filter((value): value is RepoGroup => value !== null)
}

function AgentRow({ row, now }: { row: DashboardRow; now: number }): React.JSX.Element {
  const state = getRowState(row, now)
  const isStale =
    row.kind === 'explicit' &&
    !isExplicitAgentStatusFresh(row.explicit, now, AGENT_STATUS_STALE_AFTER_MS)

  return (
    <div className="flex items-center gap-2 rounded-md border border-border/40 bg-background/60 px-2 py-1.5">
      <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted/60 text-muted-foreground">
        <Bot className="size-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-medium text-foreground">
          {formatAgentTypeLabel(row.agentType)}
        </div>
        <div className={cn('truncate text-[10px] text-muted-foreground', isStale && 'opacity-60')}>
          {row.tabTitle}
        </div>
      </div>
      <span
        className={cn(
          'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide',
          state.className
        )}
      >
        {state.label}
      </span>
    </div>
  )
}

function WorktreeCard({
  worktree,
  rows,
  isActive,
  onSelect,
  now
}: {
  worktree: Worktree
  rows: DashboardRow[]
  isActive: boolean
  onSelect: () => void
  now: number
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full flex-col gap-2 rounded-lg border px-3 py-3 text-left transition-colors',
        isActive
          ? 'border-border bg-accent/45'
          : 'border-border/50 bg-background hover:bg-accent/25'
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-semibold text-foreground">
            {worktree.displayName}
          </div>
          <div className="truncate text-[10px] text-muted-foreground">{worktree.branch}</div>
        </div>
        <div className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
          <span>{rows.length}</span>
          <ChevronRight className="size-3" />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        {rows.map((row) => (
          <AgentRow key={row.key} row={row} now={now} />
        ))}
      </div>
    </button>
  )
}

export default function AgentDashboard(): React.JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const agentStatusByPaneKey = useAppStore((s) => s.agentStatusByPaneKey)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)

  const now = Date.now()
  const repoGroups = useMemo(
    () => buildRepoGroups(repos, worktreesByRepo, tabsByWorktree, agentStatusByPaneKey, now),
    [repos, worktreesByRepo, tabsByWorktree, agentStatusByPaneKey, now]
  )

  if (repoGroups.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <div className="max-w-[18rem] space-y-2">
          <div className="text-sm font-medium text-foreground">No agent activity yet</div>
          <div className="text-xs leading-relaxed text-muted-foreground">
            Claude and Codex sessions will appear here once a terminal pane reports hook-driven
            lifecycle events or a live agent title is detected.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 scrollbar-sleek">
      <div className="flex flex-col gap-4">
        {repoGroups.map(({ repo, worktrees }) => (
          <section key={repo.id} className="flex flex-col gap-2">
            <div className="flex items-center gap-2 px-1">
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: repo.badgeColor }}
                aria-hidden="true"
              />
              <div className="truncate text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {repo.displayName}
              </div>
              <div className="text-[10px] text-muted-foreground/70">{worktrees.length}</div>
            </div>
            <div className="flex flex-col gap-2">
              {worktrees.map(({ worktree, rows }) => (
                <WorktreeCard
                  key={worktree.id}
                  worktree={worktree}
                  rows={rows}
                  now={now}
                  isActive={worktree.id === activeWorktreeId}
                  onSelect={() => setActiveWorktree(worktree.id)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
