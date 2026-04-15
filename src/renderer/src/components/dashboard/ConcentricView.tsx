import React, { useState, useCallback, useRef, useEffect } from 'react'
import { useAppStore } from '@/store'
import type { DashboardRepoGroup } from './useDashboardData'
import RepoSystem, { stateColor } from './RepoSystem'

export type TooltipData = {
  x: number
  y: number
  agentLabel: string
  state: string
  worktreeName: string
  branchName?: string
}

// ─── Scroll Position Persistence ─────────────────────────────────────────────
// Why: the concentric view unmounts when the user switches sidebar tabs. A
// module-level variable survives the unmount so scroll position is restored
// when the user returns to the dashboard.
let savedScrollTop = 0

type ConcentricViewProps = {
  groups: DashboardRepoGroup[]
  onCheckWorktree: (id: string) => void
}

export default function ConcentricView({ groups, onCheckWorktree }: ConcentricViewProps) {
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const [tooltip, setTooltip] = useState<TooltipData | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Restore scroll position on mount, save on unmount
  useEffect(() => {
    const el = containerRef.current
    if (el) {
      el.scrollTop = savedScrollTop
    }
    return () => {
      if (el) {
        savedScrollTop = el.scrollTop
      }
    }
  }, [])

  const handleClick = useCallback(
    (worktreeId: string) => {
      setActiveWorktree(worktreeId)
      setActiveView('terminal')
      onCheckWorktree(worktreeId)
    },
    [setActiveWorktree, setActiveView, onCheckWorktree]
  )

  const showTooltip = useCallback((e: React.MouseEvent, data: Omit<TooltipData, 'x' | 'y'>) => {
    const container = containerRef.current
    if (!container) {
      return
    }
    const rect = container.getBoundingClientRect()
    // Why: the tooltip is position:absolute inside the scrollable container,
    // so we must add scrollTop to map viewport coords to content coords.
    setTooltip({
      ...data,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top + container.scrollTop
    })
  }, [])

  const hideTooltip = useCallback(() => setTooltip(null), [])

  if (groups.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-[11px] text-muted-foreground">
        No repos added. Add a repo to see agent activity.
      </div>
    )
  }

  return (
    <div ref={containerRef} className="relative flex-1 overflow-y-auto scrollbar-sleek">
      <div className="flex flex-col items-center gap-1 py-2">
        {groups.map((group) => (
          <RepoSystem
            key={group.repo.id}
            group={group}
            onClick={handleClick}
            onShowTooltip={showTooltip}
            onHideTooltip={hideTooltip}
          />
        ))}
      </div>

      {/* Floating tooltip overlay — shows per-agent detail on hover */}
      {tooltip && (
        <div
          className="pointer-events-none absolute z-50 max-w-[220px] rounded-lg border border-border/50 bg-popover/95 px-3 py-2 shadow-xl backdrop-blur-sm"
          style={{
            left: tooltip.x,
            top: tooltip.y - 12,
            transform: 'translate(-50%, -100%)'
          }}
        >
          {/* Agent identity + state */}
          <div className="flex items-center gap-1.5">
            <span
              className="inline-block size-[6px] shrink-0 rounded-full"
              style={{ backgroundColor: stateColor(tooltip.state).fill }}
            />
            <span className="text-[11px] font-semibold text-foreground">{tooltip.agentLabel}</span>
            <span
              className="text-[10px] font-medium"
              style={{ color: stateColor(tooltip.state).fill }}
            >
              {tooltip.state.charAt(0).toUpperCase() + tooltip.state.slice(1)}
            </span>
          </div>

          {/* Worktree context */}
          <div className="mt-0.5 text-[9px] text-muted-foreground/50">
            {tooltip.worktreeName}
            {tooltip.branchName ? ` · ${tooltip.branchName}` : ''}
          </div>
        </div>
      )}
    </div>
  )
}
