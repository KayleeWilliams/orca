import React, { useEffect, useState, useCallback } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { AgentStatusBadge, type AgentStatusBadgeState } from '@/components/AgentStatusBadge'
import type { DashboardAgentRow as DashboardAgentRowData } from './useDashboardData'

// Why: the dashboard tracks its own rollup states (incl. 'idle'); narrow to the
// shared badge states for rendering, falling back to 'idle' for any unknown
// value so an unexpected state never crashes a row.
function asBadgeState(state: string): AgentStatusBadgeState {
  switch (state) {
    case 'working':
    case 'blocked':
    case 'waiting':
    case 'done':
    case 'idle':
      return state
    default:
      return 'idle'
  }
}

function formatTimeAgo(ts: number, now: number): string {
  const delta = now - ts
  if (delta < 60_000) {
    return 'just now'
  }
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h ago`
  }
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// Why: surface the moment the agent most recently transitioned *into* done.
// History entries are stamped with the state's own startedAt on push, so a
// past done sits at `history[i].startedAt`. When the current live state is
// done, the best approximation we have is `updatedAt` (exact on first report,
// drifts by at most one re-report interval thereafter).
function lastEnteredDoneAt(agent: DashboardAgentRowData): number | null {
  const entry = agent.entry
  if (!entry) {
    return null
  }
  if (entry.state === 'done') {
    return entry.updatedAt
  }
  for (let i = entry.stateHistory.length - 1; i >= 0; i--) {
    if (entry.stateHistory[i].state === 'done') {
      return entry.stateHistory[i].startedAt
    }
  }
  return null
}

type Props = {
  agent: DashboardAgentRowData
  onDismiss: (paneKey: string) => void
  /** Navigate directly to the tab this agent lives in. */
  onActivate: (tabId: string) => void
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    // Why: relative timestamps drift once mounted. A 30s tick keeps the "Xm
    // ago" labels honest without burning a render every second.
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

const DashboardAgentRow = React.memo(function DashboardAgentRow({
  agent,
  onDismiss,
  onActivate
}: Props) {
  const now = useNow(30_000)
  // Why: stop propagation so clicking the X doesn't also fire the worktree
  // card's click handler (which navigates away from the dashboard).
  const handleDismiss = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onDismiss(agent.paneKey)
    },
    [onDismiss, agent.paneKey]
  )
  // Why: agent rows navigate directly to the agent's own tab, while the
  // surrounding worktree card navigates to whatever tab the worktree last had
  // focused. Stop propagation so the card click handler does not run second
  // and override our tab activation.
  const handleActivate = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onActivate(agent.tab.id)
    },
    [onActivate, agent.tab.id]
  )
  const handleActivateKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        e.stopPropagation()
        onActivate(agent.tab.id)
      }
    },
    [onActivate, agent.tab.id]
  )
  const startedAt = agent.startedAt > 0 ? agent.startedAt : null
  const doneAt = lastEnteredDoneAt(agent)
  console.log('[agent-hooks:DashboardAgentRow] render', {
    paneKey: agent.paneKey,
    source: agent.source,
    state: agent.state,
    agentType: agent.agentType,
    hasEntry: agent.entry !== null,
    entryPromptLen: agent.entry?.prompt.length ?? 0,
    entryPromptPreview: agent.entry?.prompt.slice(0, 80) ?? null
  })
  const prompt = agent.entry?.prompt.trim() ?? ''

  const tsParts: string[] = []
  if (startedAt !== null) {
    tsParts.push(`started ${formatTimeAgo(startedAt, now)}`)
  }
  if (doneAt !== null) {
    tsParts.push(`done ${formatTimeAgo(doneAt, now)}`)
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleActivate}
      onKeyDown={handleActivateKeyDown}
      className={cn(
        'group flex items-center gap-1.5 px-1.5 py-0.5',
        'cursor-pointer rounded-sm hover:bg-accent/30',
        'focus-visible:outline-none focus-visible:bg-accent/40',
        agent.source === 'heuristic' && 'opacity-70'
      )}
      title={tsParts.length > 0 ? tsParts.join(' • ') : undefined}
    >
      <AgentStatusBadge agentType={agent.agentType} state={asBadgeState(agent.state)} />
      {prompt && (
        <span
          className="min-w-0 flex-1 truncate text-[10px] leading-tight text-foreground/80"
          title={prompt}
        >
          {prompt}
        </span>
      )}
      {/* Why: the timestamp and dismiss-X share a single slot so the row width
          never changes on hover AND the X's hitbox never extends into the rest
          of the row (which should stay clickable to navigate to the worktree).
          The timestamp holds the slot in normal flow; the X overlays it on
          hover with identical dimensions. */}
      {(startedAt !== null || doneAt !== null || agent.state === 'done') && (
        <span className="relative ml-auto flex shrink-0 items-center">
          {(startedAt !== null || doneAt !== null) && (
            <span
              className={cn(
                'text-[9px] leading-none text-muted-foreground/60',
                agent.state === 'done' && 'group-hover:invisible'
              )}
            >
              {doneAt !== null
                ? formatTimeAgo(doneAt, now)
                : startedAt !== null
                  ? formatTimeAgo(startedAt, now)
                  : null}
            </span>
          )}
          {agent.state === 'done' && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleDismiss}
                  className={cn(
                    'absolute inset-0 inline-flex items-center justify-center',
                    'text-muted-foreground/70 opacity-0 transition-opacity',
                    'hover:text-foreground',
                    'group-hover:opacity-100'
                  )}
                  aria-label="Dismiss done agent"
                >
                  <X className="size-2.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                Dismiss
              </TooltipContent>
            </Tooltip>
          )}
        </span>
      )}
    </div>
  )
})

export default DashboardAgentRow
