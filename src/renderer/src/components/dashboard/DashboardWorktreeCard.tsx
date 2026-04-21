import React, { useCallback } from 'react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import DashboardAgentRow from './DashboardAgentRow'
import type { DashboardWorktreeCard as DashboardWorktreeCardData } from './useDashboardData'

// Why: the worktree badge collapses to a single status dot — avoids the visual
// triple-up of Done/Done/Done (agent row + badge + agent column). Tooltip
// preserves accessibility. Blocked/waiting roll up into "Working" since the
// agent is mid-turn; idle worktrees show no dot at all.
function dominantStateDot(state: string): { label: string; className: string } | null {
  switch (state) {
    case 'working':
    case 'blocked':
    case 'waiting':
      return { label: 'Working', className: 'bg-emerald-500' }
    case 'done':
      return { label: 'Done', className: 'bg-sky-500/70' }
    default:
      return null
  }
}

type Props = {
  card: DashboardWorktreeCardData
  isFocused: boolean
  onFocus: () => void
  onCheck: () => void
  onDismissAgent: (paneKey: string) => void
  /** Navigate to a specific tab inside this card's worktree. */
  onActivateAgentTab: (worktreeId: string, tabId: string) => void
  isLast: boolean
}

const DashboardWorktreeCard = React.memo(function DashboardWorktreeCard({
  card,
  isFocused,
  onFocus,
  onCheck,
  onDismissAgent,
  onActivateAgentTab,
  isLast
}: Props) {
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const setActiveView = useAppStore((s) => s.setActiveView)

  // Why: clicking a worktree row navigates to its terminal AND marks it as
  // "checked" so done agents disappear from the active filter. The two actions
  // (navigate + check) must both fire on click.
  const handleClick = useCallback(() => {
    setActiveWorktree(card.worktree.id)
    setActiveView('terminal')
    onCheck()
  }, [card.worktree.id, setActiveWorktree, setActiveView, onCheck])

  const handleActivateAgent = useCallback(
    (tabId: string) => {
      onActivateAgentTab(card.worktree.id, tabId)
      onCheck()
    },
    [card.worktree.id, onActivateAgentTab, onCheck]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        handleClick()
      }
    },
    [handleClick]
  )

  const branchName = card.worktree.branch?.replace(/^refs\/heads\//, '') ?? ''
  const dot = dominantStateDot(card.dominantState)

  return (
    <div
      role="button"
      tabIndex={0}
      data-worktree-id={card.worktree.id}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onFocus={onFocus}
      className={cn(
        'cursor-pointer px-2.5 py-2 transition-colors duration-100',
        'hover:bg-accent/20',
        'focus-visible:outline-none focus-visible:bg-accent/30',
        isFocused && 'bg-accent/25',
        !isLast && 'border-b border-border'
      )}
    >
      {/* Worktree header row */}
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] font-semibold text-foreground truncate leading-tight">
          {card.worktree.displayName}
        </span>
        {dot && (
          <span
            className={cn('ml-auto size-2 shrink-0 rounded-full', dot.className)}
            title={dot.label}
            aria-label={dot.label}
          />
        )}
      </div>

      {/* Branch name */}
      {branchName && (
        <div className="mt-0.5 text-[10px] text-muted-foreground/60 truncate">{branchName}</div>
      )}

      {/* Agent rows with activity blocks */}
      {card.agents.length > 0 && (
        <div className="mt-1.5 flex flex-col divide-y divide-border/60">
          {card.agents.map((agent, index) => (
            <div key={agent.paneKey} className={cn(index === 0 ? 'pb-1' : 'py-1')}>
              <DashboardAgentRow
                agent={agent}
                onDismiss={onDismissAgent}
                onActivate={handleActivateAgent}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
})

export default DashboardWorktreeCard
