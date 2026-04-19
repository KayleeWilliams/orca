import React, { useState, useCallback, useMemo } from 'react'
import { useDashboardData } from './useDashboardData'
import { useDashboardFilter } from './useDashboardFilter'
import { useDashboardKeyboard } from './useDashboardKeyboard'
import DashboardFilterBar from './DashboardFilterBar'
import DashboardRepoGroup from './DashboardRepoGroup'

const AgentDashboard = React.memo(function AgentDashboard() {
  const groups = useDashboardData()

  // Why: checkedWorktreeIds tracks worktrees the user has navigated into. These
  // are hidden from the 'active' filter so done agents disappear once the user
  // acknowledges them by clicking through. Without this, done agents would
  // linger forever in the active view and dilute the "needs attention" signal.
  const [checkedWorktreeIds, setCheckedWorktreeIds] = useState<Set<string>>(new Set())

  const { filter, setFilter, filteredGroups, hasResults } = useDashboardFilter(
    groups,
    checkedWorktreeIds
  )
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(new Set())
  const [focusedWorktreeId, setFocusedWorktreeId] = useState<string | null>(null)

  const handleCheckWorktree = useCallback((worktreeId: string) => {
    setCheckedWorktreeIds((prev) => new Set(prev).add(worktreeId))
  }, [])

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
    let running = 0
    let blocked = 0
    let done = 0
    for (const group of groups) {
      for (const wt of group.worktrees) {
        for (const agent of wt.agents) {
          if (agent.state === 'working') {
            running++
          }
          if (agent.state === 'blocked' || agent.state === 'waiting') {
            blocked++
          }
          if (agent.state === 'done') {
            done++
          }
        }
      }
    }
    return { running, blocked, done }
  }, [groups])

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
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-center border-b border-border/40 px-2 py-1.5">
        <DashboardFilterBar value={filter} onChange={setFilter} />
      </div>

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
    </div>
  )
})

export default AgentDashboard
