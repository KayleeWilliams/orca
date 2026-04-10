import React, { useMemo } from 'react'
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card'
import { useAppStore } from '@/store'
import {
  detectAgentStatusFromTitle,
  formatAgentTypeLabel,
  inferAgentTypeFromTitle,
  isExplicitAgentStatusFresh
} from '@/lib/agent-status'
import { cn } from '@/lib/utils'
import type {
  AgentStatusEntry,
  AgentStatusState,
  AgentType
} from '../../../../shared/agent-status-types'
import { AGENT_STATUS_STALE_AFTER_MS as STALE_THRESHOLD_MS } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/types'

const EMPTY_TABS: TerminalTab[] = []

type HoverRow =
  | {
      kind: 'explicit'
      key: string
      tabId: string
      paneKey: string
      explicit: AgentStatusEntry
      heuristicState: 'working' | 'permission' | 'idle' | null
      tabTitle: string
      agentType: AgentType
      sortTimestamp: number
    }
  | {
      kind: 'heuristic'
      key: string
      tabId: string
      paneKey: null
      heuristicState: 'working' | 'permission' | 'idle' | null
      tabTitle: string
      agentType: AgentType
      sortTimestamp: number
    }

function stateLabel(state: AgentStatusState): string {
  switch (state) {
    case 'working':
      return 'Working'
    case 'blocked':
      return 'Blocked'
    case 'waiting':
      return 'Waiting for input'
    case 'done':
      return 'Done'
  }
}

function stateColor(state: AgentStatusState): string {
  switch (state) {
    case 'working':
      return 'text-emerald-500'
    case 'blocked':
    case 'waiting':
      return 'text-red-500'
    case 'done':
      return 'text-emerald-500'
  }
}

function sortKeyForExplicit(
  explicit: AgentStatusEntry,
  heuristicState: 'working' | 'permission' | 'idle' | null,
  now: number
): number {
  const isFresh = isExplicitAgentStatusFresh(explicit, now, STALE_THRESHOLD_MS)
  const effectiveState = isFresh ? explicit.state : heuristicState
  if (
    effectiveState === 'blocked' ||
    effectiveState === 'waiting' ||
    effectiveState === 'permission'
  ) {
    return 0
  }
  if (effectiveState === 'working') {
    return 1
  }
  return 2
}

function sortKeyForHeuristic(state: 'working' | 'permission' | 'idle' | null): number {
  if (state === 'permission') {
    return 0
  }
  if (state === 'working') {
    return 1
  }
  return 2
}

export function buildAgentStatusHoverRows(
  tabs: TerminalTab[],
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  now: number
): HoverRow[] {
  const liveTabs = tabs.filter((t) => t.ptyId)
  if (liveTabs.length === 0) {
    return []
  }

  const rows: HoverRow[] = []

  for (const tab of liveTabs) {
    const heuristicState = detectAgentStatusFromTitle(tab.title)
    const tabTitle = tab.customTitle ?? tab.title
    const explicitEntries = Object.values(agentStatusByPaneKey)
      .filter((entry) => entry.paneKey.startsWith(`${tab.id}:`))
      .sort((a, b) => b.updatedAt - a.updatedAt)

    if (explicitEntries.length > 0) {
      // Why: the design doc requires per-pane attribution in the hover. A split
      // tab can run multiple independent agents, so collapsing to one "latest"
      // row hides real work and defeats the main benefit of paneKey tracking.
      for (const explicit of explicitEntries) {
        rows.push({
          kind: 'explicit',
          key: explicit.paneKey,
          tabId: tab.id,
          paneKey: explicit.paneKey,
          explicit,
          heuristicState,
          tabTitle,
          agentType:
            explicit.agentType ?? inferAgentTypeFromTitle(explicit.terminalTitle ?? tab.title),
          sortTimestamp: explicit.updatedAt
        })
      }
      continue
    }

    rows.push({
      kind: 'heuristic',
      key: `heuristic:${tab.id}`,
      tabId: tab.id,
      paneKey: null,
      heuristicState,
      tabTitle,
      agentType: inferAgentTypeFromTitle(tab.title),
      sortTimestamp: tab.createdAt
    })
  }

  rows.sort((a, b) => {
    const ka =
      a.kind === 'explicit'
        ? sortKeyForExplicit(a.explicit, a.heuristicState, now)
        : sortKeyForHeuristic(a.heuristicState)
    const kb =
      b.kind === 'explicit'
        ? sortKeyForExplicit(b.explicit, b.heuristicState, now)
        : sortKeyForHeuristic(b.heuristicState)
    if (ka !== kb) {
      return ka - kb
    }
    return b.sortTimestamp - a.sortTimestamp
  })

  return rows
}

function StateDot({ state }: { state: AgentStatusState }): React.JSX.Element {
  if (state === 'working') {
    return (
      <span className="inline-flex h-2.5 w-2.5 shrink-0 items-center justify-center">
        <span className="block size-1.5 animate-spin rounded-full border-[1.5px] border-emerald-500 border-t-transparent" />
      </span>
    )
  }
  return (
    <span className="inline-flex h-2.5 w-2.5 shrink-0 items-center justify-center">
      <span
        className={cn(
          'block size-1.5 rounded-full',
          state === 'done' ? 'bg-emerald-500' : 'bg-red-500'
        )}
      />
    </span>
  )
}

function formatTimeAgo(updatedAt: number, now: number): string {
  const delta = now - updatedAt
  if (delta < 60_000) {
    return 'just now'
  }
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  const hours = Math.floor(minutes / 60)
  return `${hours}h ago`
}

function AgentRow({ row, now }: { row: HoverRow; now: number }): React.JSX.Element {
  if (row.kind === 'explicit') {
    const isFresh = isExplicitAgentStatusFresh(row.explicit, now, STALE_THRESHOLD_MS)
    const shouldUseHeuristic = !isFresh && row.heuristicState !== null

    return (
      <div className="flex flex-col gap-1 border-b border-border/30 py-1.5 last:border-0">
        <div className="flex items-center gap-1.5">
          {shouldUseHeuristic ? (
            <span className="inline-flex h-2.5 w-2.5 shrink-0 items-center justify-center">
              <span
                className={cn(
                  'block size-1.5 rounded-full',
                  row.heuristicState === 'working'
                    ? 'bg-emerald-500'
                    : row.heuristicState === 'permission'
                      ? 'bg-red-500'
                      : 'bg-neutral-500/40'
                )}
              />
            </span>
          ) : (
            <StateDot state={row.explicit.state} />
          )}
          <span
            className={cn(
              'text-[11px] font-medium',
              shouldUseHeuristic ? 'text-muted-foreground' : stateColor(row.explicit.state)
            )}
          >
            {shouldUseHeuristic
              ? row.heuristicState === 'permission'
                ? 'Needs attention'
                : row.heuristicState === 'working'
                  ? 'Working'
                  : 'Idle'
              : stateLabel(row.explicit.state)}
          </span>
          <span className="truncate text-[10px] text-muted-foreground/70">
            {formatAgentTypeLabel(row.agentType)}
          </span>
          <span className="ml-auto text-[10px] text-muted-foreground/50">
            {formatTimeAgo(row.explicit.updatedAt, now)}
          </span>
        </div>
        {row.explicit.summary && (
          <div className={cn('pl-4 text-[11px] leading-snug', !isFresh && 'opacity-60')}>
            {row.explicit.summary}
          </div>
        )}
        {row.explicit.next && (
          <div
            className={cn(
              'pl-4 text-[10.5px] leading-snug text-muted-foreground',
              !isFresh && 'opacity-60'
            )}
          >
            Next: {row.explicit.next}
          </div>
        )}
        {!isFresh && (
          <div className="pl-4 text-[10px] italic text-muted-foreground/60">
            Showing last reported task details; live terminal state has taken precedence.
          </div>
        )}
      </div>
    )
  }

  const heuristicLabel =
    row.heuristicState === 'working'
      ? 'Working'
      : row.heuristicState === 'permission'
        ? 'Needs attention'
        : 'Idle'

  return (
    <div className="flex flex-col gap-1 border-b border-border/30 py-1.5 last:border-0">
      <div className="flex items-center gap-1.5">
        <span className="inline-flex h-2.5 w-2.5 shrink-0 items-center justify-center">
          <span
            className={cn(
              'block size-1.5 rounded-full',
              row.heuristicState === 'working'
                ? 'bg-emerald-500'
                : row.heuristicState === 'permission'
                  ? 'bg-red-500'
                  : 'bg-neutral-500/40'
            )}
          />
        </span>
        <span className="text-[11px] font-medium text-muted-foreground">{heuristicLabel}</span>
        <span className="truncate text-[10px] text-muted-foreground/70">
          {formatAgentTypeLabel(row.agentType)}
        </span>
      </div>
      <div className="truncate pl-4 text-[10.5px] text-muted-foreground/60">{row.tabTitle}</div>
      <div className="pl-4 text-[10px] italic text-muted-foreground/40">
        No task details reported
      </div>
    </div>
  )
}

type AgentStatusHoverProps = {
  worktreeId: string
  children: React.ReactNode
}

const AgentStatusHover = React.memo(function AgentStatusHover({
  worktreeId,
  children
}: AgentStatusHoverProps) {
  const tabs = useAppStore((s) => s.tabsByWorktree[worktreeId] ?? EMPTY_TABS)
  const agentStatusByPaneKey = useAppStore((s) => s.agentStatusByPaneKey)
  const agentStatusEpoch = useAppStore((s) => s.agentStatusEpoch)

  // Why: timestamps in the hover are relative labels, so recompute "now" when
  // the source rows change or a stored freshness boundary expires, rather than
  // on an interval that would churn the sidebar every minute.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => Date.now(), [agentStatusByPaneKey, agentStatusEpoch, tabs])
  const rows = useMemo(
    () => buildAgentStatusHoverRows(tabs, agentStatusByPaneKey, now),
    [tabs, agentStatusByPaneKey, now]
  )

  return (
    <HoverCard openDelay={300}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent side="right" align="start" className="w-72 p-3 text-xs">
        {rows.length === 0 ? (
          <div className="py-1 text-center text-muted-foreground">No running agents</div>
        ) : (
          <div className="flex flex-col">
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
              Running agents ({rows.length})
            </div>
            {rows.map((row) => (
              <AgentRow key={row.key} row={row} now={now} />
            ))}
          </div>
        )}
      </HoverCardContent>
    </HoverCard>
  )
})

export default AgentStatusHover
