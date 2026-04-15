import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { LayoutList, Target } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDashboardData } from './useDashboardData'
import { useDashboardFilter } from './useDashboardFilter'
import { useDashboardKeyboard } from './useDashboardKeyboard'
import DashboardFilterBar from './DashboardFilterBar'
import DashboardRepoGroup from './DashboardRepoGroup'
import ConcentricView from './ConcentricView'
import { useRetainedAgents } from './useRetainedAgents'

type ViewMode = 'list' | 'radial'

const AgentDashboard = React.memo(function AgentDashboard() {
  const liveGroups = useDashboardData()
  // Why: useRetainedAgents merges "done" entries for agents that have
  // disappeared from live data (terminal closed, pane exited) so they
  // persist in the dashboard until the user clicks through to dismiss them.
  const { enrichedGroups: groups, dismissWorktreeAgents } = useRetainedAgents(liveGroups)

  // Why: viewMode toggles between the list (card grid) and radial (concentric
  // circles) views. Default to 'radial' — the concentric view is the primary
  // visualization. The list view is available as a familiar fallback.
  const [viewMode, setViewMode] = useState<ViewMode>('radial')

  // Why: checkedWorktreeIds tracks which "done" worktrees the user has already
  // clicked through to. These are hidden from the 'active' filter so the
  // dashboard only shows items that still need attention.
  const [checkedWorktreeIds, setCheckedWorktreeIds] = useState<Set<string>>(new Set())
  const prevDominantStates = useRef<Record<string, string>>({})

  const { filter, setFilter, filteredGroups, hasResults } = useDashboardFilter(
    groups,
    checkedWorktreeIds
  )
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(new Set())
  const [focusedWorktreeId, setFocusedWorktreeId] = useState<string | null>(null)

  // Why: when a worktree transitions back to working/blocked after being checked
  // as done, automatically un-check it so it reappears in the active filter.
  useEffect(() => {
    const newStates: Record<string, string> = {}
    const toUncheck: string[] = []
    for (const group of groups) {
      for (const wt of group.worktrees) {
        newStates[wt.worktree.id] = wt.dominantState
        const prev = prevDominantStates.current[wt.worktree.id]
        if (
          checkedWorktreeIds.has(wt.worktree.id) &&
          prev === 'done' &&
          (wt.dominantState === 'working' || wt.dominantState === 'blocked')
        ) {
          toUncheck.push(wt.worktree.id)
        }
      }
    }
    prevDominantStates.current = newStates
    if (toUncheck.length > 0) {
      setCheckedWorktreeIds((prev) => {
        const next = new Set(prev)
        for (const id of toUncheck) {
          next.delete(id)
        }
        return next
      })
    }
  }, [groups, checkedWorktreeIds])

  const handleCheckWorktree = useCallback(
    (worktreeId: string) => {
      setCheckedWorktreeIds((prev) => new Set(prev).add(worktreeId))
      // Also dismiss any retained "done" agents for this worktree so they
      // vanish from both the list and concentric views after the user checks.
      dismissWorktreeAgents(worktreeId)
    },
    [dismissWorktreeAgents]
  )

  const toggleCollapse = useCallback((repoId: string) => {
    setCollapsedRepos((prev) => {
      const next = new Set(prev)
      if (next.has(repoId)) {
        next.delete(repoId)
      } else {
        next.add(repoId)
      }
      return next
    })
  }, [])

  useDashboardKeyboard({
    filteredGroups,
    collapsedRepos,
    focusedWorktreeId,
    setFocusedWorktreeId,
    filter,
    setFilter
  })

  // Summary stats across all repos (unfiltered)
  const stats = useMemo(() => {
    let runningAgents = 0
    let blockedAgents = 0
    let doneAgents = 0
    for (const group of groups) {
      for (const wt of group.worktrees) {
        for (const agent of wt.agents) {
          if (agent.state === 'working') {
            runningAgents++
          }
          if (agent.state === 'blocked' || agent.state === 'waiting') {
            blockedAgents++
          }
          if (agent.state === 'done') {
            doneAgents++
          }
        }
      }
    }
    return { running: runningAgents, blocked: blockedAgents, done: doneAgents }
  }, [groups])

  // Empty state: no repos at all
  if (groups.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center p-4">
        <div className="text-center text-[11px] text-muted-foreground">
          No repos added. Add a repo to see agent activity.
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {/* Summary stats header + view toggle */}
      <div className="shrink-0 border-b border-border/40 px-3 py-2">
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          {stats.running > 0 && (
            <span>
              <span className="font-semibold text-emerald-500">{stats.running}</span> running
            </span>
          )}
          {stats.blocked > 0 && (
            <span>
              <span className="font-semibold text-amber-500">{stats.blocked}</span> blocked
            </span>
          )}
          {stats.done > 0 && (
            <span>
              <span className="font-semibold text-sky-500/80">{stats.done}</span> done
            </span>
          )}
          {stats.running === 0 && stats.blocked === 0 && stats.done === 0 && (
            <span className="text-muted-foreground/50">No active agents</span>
          )}

          {/* View mode toggle */}
          <div className="ml-auto flex items-center gap-0.5 rounded-md border border-border/40 p-0.5">
            <button
              type="button"
              onClick={() => setViewMode('radial')}
              className={cn(
                'flex items-center justify-center rounded p-1 transition-colors',
                viewMode === 'radial'
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground/50 hover:text-muted-foreground'
              )}
              aria-label="Concentric view"
            >
              <Target size={12} />
            </button>
            <button
              type="button"
              onClick={() => setViewMode('list')}
              className={cn(
                'flex items-center justify-center rounded p-1 transition-colors',
                viewMode === 'list'
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground/50 hover:text-muted-foreground'
              )}
              aria-label="List view"
            >
              <LayoutList size={12} />
            </button>
          </div>
        </div>
      </div>

      {/* Filter bar — only shown in list mode (concentric view shows everything) */}
      {viewMode === 'list' && (
        <div className="flex shrink-0 items-center justify-center border-b border-border/40 px-2 py-1.5">
          <DashboardFilterBar value={filter} onChange={setFilter} />
        </div>
      )}

      {/* Scrollable content — switches between concentric and list views */}
      {viewMode === 'radial' ? (
        <ConcentricView groups={groups} onCheckWorktree={handleCheckWorktree} />
      ) : (
        <div className="flex-1 overflow-y-auto scrollbar-sleek">
          <div className="flex flex-col gap-2 p-2">
            {hasResults ? (
              filteredGroups.map((group) => (
                <DashboardRepoGroup
                  key={group.repo.id}
                  group={group}
                  isCollapsed={collapsedRepos.has(group.repo.id)}
                  onToggleCollapse={() => toggleCollapse(group.repo.id)}
                  focusedWorktreeId={focusedWorktreeId}
                  onFocusWorktree={setFocusedWorktreeId}
                  onCheckWorktree={handleCheckWorktree}
                />
              ))
            ) : (
              <div className="flex flex-col items-center justify-center py-12 gap-2">
                <div className="text-[11px] text-muted-foreground/60">
                  {filter === 'active' ? 'All agents are idle.' : 'No worktrees match this filter.'}
                </div>
                {filter !== 'all' && (
                  <button
                    type="button"
                    onClick={() => setFilter('all')}
                    className="text-[11px] text-primary/70 hover:text-primary hover:underline"
                  >
                    Show all
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
})

export default AgentDashboard
