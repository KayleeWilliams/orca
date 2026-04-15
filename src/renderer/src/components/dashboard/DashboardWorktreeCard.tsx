import React, { useCallback } from 'react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import DashboardAgentRow from './DashboardAgentRow'
import type { DashboardWorktreeCard as DashboardWorktreeCardData } from './useDashboardData'

function dominantStateBadge(state: string): { label: string; className: string } {
  switch (state) {
    case 'working':
      return { label: 'Active', className: 'bg-emerald-500/15 text-emerald-500' }
    case 'blocked':
      return { label: 'Blocked', className: 'bg-amber-500/15 text-amber-500' }
    case 'done':
      return { label: 'Done', className: 'bg-sky-500/15 text-sky-500/80' }
    default:
      return { label: 'Idle', className: 'bg-zinc-500/10 text-zinc-500' }
  }
}

type Props = {
  card: DashboardWorktreeCardData
  isFocused: boolean
  onFocus: () => void
  onCheck: () => void
  isLast: boolean
}

const DashboardWorktreeCard = React.memo(function DashboardWorktreeCard({
  card,
  isFocused,
  onFocus,
  onCheck,
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
  const badge = dominantStateBadge(card.dominantState)

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
        !isLast && 'border-b border-border/15'
      )}
    >
      {/* Worktree header row */}
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] font-semibold text-foreground truncate leading-tight">
          {card.worktree.displayName}
        </span>
        <span
          className={cn(
            'ml-auto shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium',
            badge.className
          )}
        >
          {badge.label}
        </span>
      </div>

      {/* Branch name */}
      {branchName && (
        <div className="mt-0.5 text-[10px] text-muted-foreground/60 truncate">{branchName}</div>
      )}

      {/* Agent rows with activity blocks */}
      {card.agents.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1">
          {card.agents.map((agent) => (
            <DashboardAgentRow key={agent.paneKey} agent={agent} />
          ))}
        </div>
      )}
    </div>
  )
})

export default DashboardWorktreeCard
