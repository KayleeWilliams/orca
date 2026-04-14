import React, { useMemo, useState } from 'react'
import { Bot, ChevronRight, Orbit, Rows3 } from 'lucide-react'
import { useAppStore } from '@/store'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import { cn } from '@/lib/utils'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import { buildRepoGroups, formatRowAgentLabel, getRowState } from './model'
import ConcentricView from './ConcentricView'
import type { DashboardRow } from './model'

type DashboardMode = 'concentric' | 'list'

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
          {formatRowAgentLabel(row)}
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

function ListView({
  repoGroups,
  now,
  activeWorktreeId,
  onSelectWorktree
}: {
  repoGroups: ReturnType<typeof buildRepoGroups>
  now: number
  activeWorktreeId: string | null
  onSelectWorktree: (worktreeId: string) => void
}): React.JSX.Element {
  return (
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
              <button
                key={worktree.id}
                type="button"
                onClick={() => onSelectWorktree(worktree.id)}
                className={cn(
                  'flex w-full flex-col gap-2 rounded-lg border px-3 py-3 text-left transition-colors',
                  activeWorktreeId === worktree.id
                    ? 'border-border bg-accent/45'
                    : 'border-border/50 bg-background hover:bg-accent/25'
                )}
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] font-semibold text-foreground">
                      {worktree.displayName}
                    </div>
                    <div className="truncate text-[10px] text-muted-foreground">
                      {worktree.branch}
                    </div>
                  </div>
                  <div className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                    <span>{rows.length}</span>
                    <ChevronRight className="size-3" />
                  </div>
                </div>
                {rows.length > 0 ? (
                  <div className="flex flex-col gap-1.5">
                    {rows.map((row) => (
                      <AgentRow key={row.key} row={row} now={now} />
                    ))}
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed border-border/45 bg-muted/25 px-2 py-2 text-[10px] text-muted-foreground">
                    No active agents in this worktree
                  </div>
                )}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

export default function AgentDashboard(): React.JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const agentStatusByPaneKey = useAppStore((s) => s.agentStatusByPaneKey)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const [mode, setMode] = useState<DashboardMode>('concentric')

  const now = Date.now()
  const repoGroups = useMemo(
    () => buildRepoGroups(repos, worktreesByRepo, tabsByWorktree, agentStatusByPaneKey, now),
    [repos, worktreesByRepo, tabsByWorktree, agentStatusByPaneKey, now]
  )

  if (repoGroups.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <div className="max-w-[18rem] space-y-2">
          <div className="text-sm font-medium text-foreground">No worktrees yet</div>
          <div className="text-xs leading-relaxed text-muted-foreground">
            Add or create a worktree to populate the dashboard.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 scrollbar-sleek">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Agent Dashboard
          </div>
          <div className="text-[11px] text-muted-foreground">
            Lifecycle-first overview across all active worktrees
          </div>
        </div>
        <ToggleGroup
          type="single"
          value={mode}
          onValueChange={(value) => {
            if (value === 'concentric' || value === 'list') {
              setMode(value)
            }
          }}
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem value="concentric" aria-label="Concentric view">
            <Orbit className="mr-1 size-3.5" />
            Concentric
          </ToggleGroupItem>
          <ToggleGroupItem value="list" aria-label="List view">
            <Rows3 className="mr-1 size-3.5" />
            List
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {mode === 'concentric' ? (
        <ConcentricView
          repoGroups={repoGroups}
          now={now}
          activeWorktreeId={activeWorktreeId}
          onSelectWorktree={setActiveWorktree}
        />
      ) : (
        <ListView
          repoGroups={repoGroups}
          now={now}
          activeWorktreeId={activeWorktreeId}
          onSelectWorktree={setActiveWorktree}
        />
      )}
    </div>
  )
}
