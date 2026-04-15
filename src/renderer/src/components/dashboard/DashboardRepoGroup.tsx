import React from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import DashboardWorktreeCard from './DashboardWorktreeCard'
import type { DashboardRepoGroup as DashboardRepoGroupData } from './useDashboardData'

type Props = {
  group: DashboardRepoGroupData
  isCollapsed: boolean
  onToggleCollapse: () => void
  focusedWorktreeId: string | null
  onFocusWorktree: (worktreeId: string) => void
  onCheckWorktree: (worktreeId: string) => void
}

const DashboardRepoGroup = React.memo(function DashboardRepoGroup({
  group,
  isCollapsed,
  onToggleCollapse,
  focusedWorktreeId,
  onFocusWorktree,
  onCheckWorktree
}: Props) {
  const totalAgents = group.worktrees.reduce((sum, wt) => sum + wt.agents.length, 0)
  const Icon = isCollapsed ? ChevronRight : ChevronDown

  return (
    <div className="rounded-lg bg-accent/20 border border-border/30 overflow-hidden">
      {/* Repo header */}
      <button
        type="button"
        onClick={onToggleCollapse}
        className={cn(
          'flex w-full items-center gap-1.5 px-2.5 py-2',
          'text-left text-[11px] font-medium text-foreground/90',
          'hover:bg-accent/30 transition-colors duration-100'
        )}
      >
        <Icon className="size-3 shrink-0 text-muted-foreground" />
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: group.repo.badgeColor }}
        />
        <span className="truncate font-semibold">{group.repo.displayName}</span>
        <span className="ml-auto flex items-center gap-2 shrink-0 text-[10px] text-muted-foreground/60">
          <span>{group.worktrees.length} wt</span>
          <span>{totalAgents} agents</span>
          {group.attentionCount > 0 && (
            <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-medium text-amber-500">
              {group.attentionCount}
            </span>
          )}
        </span>
      </button>

      {/* Worktree rows */}
      {!isCollapsed && group.worktrees.length > 0 && (
        <div className="border-t border-border/20">
          {group.worktrees.map((card, i) => (
            <DashboardWorktreeCard
              key={card.worktree.id}
              card={card}
              isFocused={focusedWorktreeId === card.worktree.id}
              onFocus={() => onFocusWorktree(card.worktree.id)}
              onCheck={() => onCheckWorktree(card.worktree.id)}
              isLast={i === group.worktrees.length - 1}
            />
          ))}
        </div>
      )}

      {!isCollapsed && group.worktrees.length === 0 && (
        <div className="border-t border-border/20 px-2.5 py-2 text-[10px] text-muted-foreground/50 italic">
          (0 worktrees)
        </div>
      )}
    </div>
  )
})

export default DashboardRepoGroup
