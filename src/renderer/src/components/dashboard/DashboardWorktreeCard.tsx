import React, { useCallback } from 'react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import DashboardAgentRow from './DashboardAgentRow'
import type { DashboardWorktreeCard as DashboardWorktreeCardData } from './useDashboardData'

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

  // Why: clicking an agent row only navigates to that agent's tab. It must not
  // call onCheck() — that would mark the worktree as checked AND dismiss all
  // retained done rows in it, which erases the signal the user was clicking
  // through to investigate. Only the X button on a done row should dismiss it.
  const handleActivateAgent = useCallback(
    (tabId: string) => {
      onActivateAgentTab(card.worktree.id, tabId)
    },
    [card.worktree.id, onActivateAgentTab]
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
        !isLast && 'border-b border-border/60'
      )}
    >
      {/* Worktree header row */}
      <div className="flex items-center gap-1.5 min-w-0">
        {/* Why: the repo indicator (dot + name) sits on every row now that the
            per-repo card has been flattened — without it, the user can't tell
            which repo a worktree belongs to at a glance. */}
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: card.repo.badgeColor }}
          aria-hidden
        />
        <span className="text-[10px] text-muted-foreground/70 truncate shrink-0 max-w-[40%]">
          {card.repo.displayName}
        </span>
        <span className="text-[10px] text-muted-foreground/40 shrink-0">/</span>
        <span className="text-[11px] font-semibold text-foreground truncate leading-tight min-w-0">
          {card.worktree.displayName}
        </span>
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
