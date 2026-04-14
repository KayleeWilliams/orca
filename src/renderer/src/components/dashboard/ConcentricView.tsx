import React from 'react'
import { cn } from '@/lib/utils'
import { formatRowAgentLabel, formatWorktreeStateSummary, getRowState } from './model'
import type { RepoGroup } from './model'

function bubbleSize(agentCount: number): number {
  return Math.max(92, Math.min(132, 88 + agentCount * 8))
}

function ringPosition(index: number, total: number, ringIndex: number): { x: number; y: number } {
  const radius = 118 + ringIndex * 68
  const angle = (Math.PI * 2 * index) / Math.max(total, 1) - Math.PI / 2
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius
  }
}

function splitIntoRings(count: number): number[] {
  if (count <= 6) {
    return [count]
  }
  if (count <= 14) {
    return [6, count - 6]
  }
  return [6, 8, count - 14]
}

function AgentDots({
  rows,
  now
}: {
  rows: RepoGroup['worktrees'][number]['rows']
  now: number
}): React.JSX.Element {
  if (rows.length === 0) {
    return (
      <div className="mt-2 text-[9px] uppercase tracking-[0.14em] text-muted-foreground/65">
        No agents
      </div>
    )
  }

  return (
    <div className="mt-2 flex flex-wrap justify-center gap-1">
      {rows.slice(0, 6).map((row) => {
        const state = getRowState(row, now)
        return (
          <span
            key={row.key}
            title={`${formatRowAgentLabel(row)} • ${state.label}`}
            className={cn('size-2 rounded-full', state.dotClassName)}
          />
        )
      })}
    </div>
  )
}

function RepoOrb({
  group,
  now,
  activeWorktreeId,
  onSelectWorktree
}: {
  group: RepoGroup
  now: number
  activeWorktreeId: string | null
  onSelectWorktree: (worktreeId: string) => void
}): React.JSX.Element {
  const ringCounts = splitIntoRings(group.worktrees.length)
  let offset = 0

  return (
    <section className="relative flex min-h-[30rem] items-center justify-center overflow-hidden rounded-[2rem] border border-border/50 bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.06),transparent_58%)] px-4 py-8">
      <div className="pointer-events-none absolute inset-0 opacity-60">
        {[140, 230, 310].map((size) => (
          <div
            key={size}
            className="absolute left-1/2 top-1/2 rounded-full border border-border/30"
            style={{
              width: size,
              height: size,
              transform: 'translate(-50%, -50%)'
            }}
          />
        ))}
      </div>

      <div
        className="relative flex size-40 items-center justify-center rounded-full border text-center shadow-sm"
        style={{
          background: `radial-gradient(circle at 30% 30%, ${group.repo.badgeColor}33, transparent 58%), var(--background)`,
          borderColor: `${group.repo.badgeColor}55`
        }}
      >
        <div className="space-y-1 px-4">
          <div
            className="mx-auto size-2 rounded-full"
            style={{ backgroundColor: group.repo.badgeColor }}
          />
          <div className="line-clamp-3 text-[13px] font-semibold leading-tight text-foreground">
            {group.repo.displayName}
          </div>
          <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            {group.worktrees.length} worktrees
          </div>
        </div>
      </div>

      {ringCounts.map((count, ringIndex) => {
        const worktrees = group.worktrees.slice(offset, offset + count)
        offset += count

        return worktrees.map(({ worktree, rows }, index) => {
          const position = ringPosition(index, count, ringIndex)
          const size = bubbleSize(rows.length)
          const isActive = worktree.id === activeWorktreeId

          return (
            <button
              key={worktree.id}
              type="button"
              onClick={() => onSelectWorktree(worktree.id)}
              className={cn(
                'absolute flex flex-col items-center justify-center rounded-full border px-3 text-center transition-all',
                'hover:scale-[1.03] hover:border-foreground/30',
                isActive
                  ? 'border-foreground/35 bg-accent/70 shadow-[0_10px_30px_rgba(0,0,0,0.12)]'
                  : rows.length === 0
                    ? 'border-border/45 bg-muted/35 shadow-[0_4px_16px_rgba(0,0,0,0.06)]'
                    : 'border-border/60 bg-background/90 shadow-[0_6px_20px_rgba(0,0,0,0.08)]'
              )}
              style={{
                width: size,
                height: size,
                left: `calc(50% + ${position.x}px - ${size / 2}px)`,
                top: `calc(50% + ${position.y}px - ${size / 2}px)`
              }}
            >
              <div className="line-clamp-2 text-[11px] font-semibold leading-tight text-foreground">
                {worktree.displayName}
              </div>
              <div className="mt-1 truncate text-[9px] text-muted-foreground">
                {worktree.branch}
              </div>
              <div className="mt-1 text-[9px] uppercase tracking-[0.12em] text-muted-foreground/80">
                {formatWorktreeStateSummary(rows, now)}
              </div>
              <AgentDots rows={rows} now={now} />
            </button>
          )
        })
      })}
    </section>
  )
}

export default function ConcentricView({
  repoGroups,
  now,
  activeWorktreeId,
  onSelectWorktree
}: {
  repoGroups: RepoGroup[]
  now: number
  activeWorktreeId: string | null
  onSelectWorktree: (worktreeId: string) => void
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
      {repoGroups.map((group) => (
        <RepoOrb
          key={group.repo.id}
          group={group}
          now={now}
          activeWorktreeId={activeWorktreeId}
          onSelectWorktree={onSelectWorktree}
        />
      ))}
    </div>
  )
}
