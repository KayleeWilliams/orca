import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { Search, X } from 'lucide-react'
import { useAppStore } from '@/store'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useDashboardData } from './useDashboardData'
import { useDashboardFilter } from './useDashboardFilter'
import { useDashboardKeyboard } from './useDashboardKeyboard'
import { useRetainedAgents } from './useRetainedAgents'
import DashboardFilterBar from './DashboardFilterBar'
import DashboardWorktreeCard from './DashboardWorktreeCard'

const AgentDashboard = React.memo(function AgentDashboard() {
  const liveGroups = useDashboardData()
  // Why: useRetainedAgents keeps a "done" row visible after the terminal/pane
  // is closed and the explicit status entry is evicted from the store. Without
  // this, a completed agent vanishes entirely — and the user loses the signal
  // that the agent finished. Retained rows are dismissed when the user clicks
  // through to the worktree.
  const {
    enrichedGroups: groups,
    dismissWorktreeAgents,
    dismissAgent
  } = useRetainedAgents(liveGroups)
  const removeAgentStatus = useAppStore((s) => s.removeAgentStatus)
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const setActiveView = useAppStore((s) => s.setActiveView)

  // Why: the store's explicit status entry persists after an agent reports
  // `done` until the pane actually exits — which may be much later, since the
  // user often leaves the Claude/Codex session alive to review output. The
  // per-row dismiss removes both the live store entry and any retained entry
  // so done agents don't pile up indefinitely in the dashboard.
  const handleDismissAgent = useCallback(
    (paneKey: string) => {
      removeAgentStatus(paneKey)
      dismissAgent(paneKey)
    },
    [removeAgentStatus, dismissAgent]
  )

  const [searchQuery, setSearchQuery] = useState('')
  const { filter, setFilter, filteredWorktrees, hasResults } = useDashboardFilter(
    groups,
    searchQuery
  )
  const [focusedWorktreeId, setFocusedWorktreeId] = useState<string | null>(null)

  // Why: the keyboard hook scopes its listener to this container (not window)
  // so dashboard shortcuts (1-5, arrows, Enter, Escape) don't hijack the
  // terminal or other focused inputs when the dashboard pane is merely open.
  const containerRef = useRef<HTMLDivElement>(null)

  const handleCheckWorktree = useCallback(
    (worktreeId: string) => {
      // Why: when the user clicks a done worktree, they've acknowledged it.
      // Dismiss retained rows so they stop lingering in the list.
      dismissWorktreeAgents(worktreeId)
    },
    [dismissWorktreeAgents]
  )

  // Why: clicking an agent row takes the user to the specific tab the agent
  // ran in, not just the worktree's last-active tab. Retained rows can outlive
  // their pane — fall back to worktree-only activation when the tab is no
  // longer present so the click still lands somewhere useful.
  const handleActivateAgentTab = useCallback(
    (worktreeId: string, tabId: string) => {
      setActiveWorktree(worktreeId)
      setActiveView('terminal')
      const tabs = useAppStore.getState().tabsByWorktree[worktreeId] ?? []
      if (tabs.some((t) => t.id === tabId)) {
        setActiveTab(tabId)
      }
    },
    [setActiveWorktree, setActiveTab, setActiveView]
  )

  useDashboardKeyboard({
    filteredWorktrees,
    focusedWorktreeId,
    setFocusedWorktreeId,
    filter,
    setFilter,
    containerRef
  })

  // Why: focus the container on mount so keyboard shortcuts work immediately
  // without requiring an initial click inside the dashboard. tabIndex={-1}
  // on the container makes it programmatically focusable without inserting
  // it into the tab order.
  useEffect(() => {
    containerRef.current?.focus()
  }, [])

  const handleClearSearch = useCallback(() => setSearchQuery(''), [])

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

  const searchActive = searchQuery.trim().length > 0
  const showNoResults = searchActive && !hasResults

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className="flex h-full w-full flex-col overflow-hidden outline-none"
    >
      {/* Why: hide the stats strip entirely when there's nothing to count —
          the empty-state message in the main panel already tells the user
          there's no activity, and showing both reads as duplicated chrome. */}
      {(stats.running > 0 || stats.blocked > 0 || stats.done > 0) && (
        <div className="shrink-0 border-b border-border/40 px-3 py-2">
          <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
            {stats.running > 0 && (
              <span>
                <span className="font-semibold text-emerald-500">{stats.running}</span> active
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
          </div>
        </div>
      )}

      <div className="flex shrink-0 flex-col gap-1.5 border-b border-border/40 px-2 py-1.5">
        <div className="relative flex items-center">
          <Search className="absolute left-2 size-3.5 text-muted-foreground pointer-events-none" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search..."
            className="h-7 pl-7 pr-7 text-[11px] border-none bg-muted/50 shadow-none focus-visible:ring-1 focus-visible:ring-ring/30"
          />
          {searchActive && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={handleClearSearch}
              className="absolute right-1 size-5"
              aria-label="Clear search"
            >
              <X className="size-3" />
            </Button>
          )}
        </div>
        <div className="flex items-center justify-center">
          <DashboardFilterBar value={filter} onChange={setFilter} />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-sleek">
        {hasResults ? (
          <div className="flex flex-col">
            {filteredWorktrees.map((card, i) => (
              <DashboardWorktreeCard
                key={card.worktree.id}
                card={card}
                isFocused={focusedWorktreeId === card.worktree.id}
                onFocus={() => setFocusedWorktreeId(card.worktree.id)}
                onCheck={() => handleCheckWorktree(card.worktree.id)}
                onDismissAgent={handleDismissAgent}
                onActivateAgentTab={handleActivateAgentTab}
                isLast={i === filteredWorktrees.length - 1}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-12 gap-2">
            <div className="text-[11px] text-muted-foreground/60">
              {showNoResults
                ? 'No matches.'
                : filter === 'active'
                  ? 'No agents need your attention.'
                  : filter === 'blocked'
                    ? 'No agents are blocked.'
                    : filter === 'done'
                      ? 'No completed agents to show.'
                      : 'No agent activity yet.'}
            </div>
            {showNoResults ? (
              <button
                type="button"
                onClick={handleClearSearch}
                className="text-[11px] text-primary/70 hover:text-primary hover:underline"
              >
                Clear search
              </button>
            ) : (
              filter !== 'all' && (
                <button
                  type="button"
                  onClick={() => setFilter('all')}
                  className="text-[11px] text-primary/70 hover:text-primary hover:underline"
                >
                  Show all
                </button>
              )
            )}
          </div>
        )}
      </div>
    </div>
  )
})

export default AgentDashboard
