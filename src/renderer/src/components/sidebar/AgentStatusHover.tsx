import React, { useMemo } from 'react'
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card'
import { useAppStore } from '@/store'
import {
  detectAgentStatusFromTitle,
  getAgentLabel,
  isExplicitAgentStatusFresh
} from '@/lib/agent-status'
import { cn } from '@/lib/utils'
import { AgentStatusBadge, type AgentStatusBadgeState } from '@/components/AgentStatusBadge'
import type { AgentStatusEntry, AgentType } from '../../../../shared/agent-status-types'
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
          agentType: explicit.agentType ?? 'unknown',
          sortTimestamp: explicit.updatedAt
        })
      }
      continue
    }

    // Why: a live PTY tab is not necessarily running an agent — the user may
    // have opened a plain shell ("Terminal 1"). Only surface a heuristic row
    // when the title actually looks like an agent (detectable status or a
    // recognizable agent name); otherwise the hover falsely reports shells as
    // "Idle Agent / No task details reported" and inflates "Running agents (N)".
    if (heuristicState === null && getAgentLabel(tab.title) === null) {
      continue
    }

    rows.push({
      kind: 'heuristic',
      key: `heuristic:${tab.id}`,
      tabId: tab.id,
      paneKey: null,
      heuristicState,
      tabTitle,
      // Why: we no longer guess agent family from titles — the explicit
      // agentType from the hook is the source of truth. Heuristic rows
      // render with a neutral icon until the hook reports.
      agentType: 'unknown',
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

// Why: the heuristic rollup only distinguishes 'working' / 'permission' /
// 'idle'. Map it into the shared badge state vocabulary so both the hover and
// dashboard render identical badges for "agent needs attention".
function heuristicToBadgeState(
  state: 'working' | 'permission' | 'idle' | null
): AgentStatusBadgeState {
  if (state === 'working') {
    return 'working'
  }
  if (state === 'permission') {
    return 'permission'
  }
  return 'idle'
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
    const badgeState: AgentStatusBadgeState = shouldUseHeuristic
      ? heuristicToBadgeState(row.heuristicState)
      : row.explicit.state

    return (
      <div className="flex flex-col gap-1 border-b border-border/30 py-1.5 last:border-0">
        <div className="flex items-center gap-1.5">
          <AgentStatusBadge agentType={row.agentType} state={badgeState} />
          <span className="ml-auto text-[10px] text-muted-foreground/50">
            {formatTimeAgo(row.explicit.updatedAt, now)}
          </span>
        </div>
        {row.explicit.prompt && (
          <div className={cn('pl-5 text-[11px] leading-snug', !isFresh && 'opacity-60')}>
            {row.explicit.prompt}
          </div>
        )}
        {!isFresh && (
          <div className="pl-5 text-[10px] italic text-muted-foreground/60">
            Showing last reported task details; live terminal state has taken precedence.
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1 border-b border-border/30 py-1.5 last:border-0">
      <div className="flex items-center gap-1.5">
        <AgentStatusBadge
          agentType={row.agentType}
          state={heuristicToBadgeState(row.heuristicState)}
        />
      </div>
      <div className="truncate pl-5 text-[10.5px] text-muted-foreground/60">{row.tabTitle}</div>
      <div className="pl-5 text-[10px] italic text-muted-foreground/40">
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
