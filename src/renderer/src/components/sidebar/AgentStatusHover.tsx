import React, { useCallback, useMemo } from 'react'
import { X } from 'lucide-react'
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card'
import { useAppStore } from '@/store'
import { AgentIcon } from '@/lib/agent-catalog'
import { AgentStateDot, type AgentDotState, agentStateLabel } from '@/components/AgentStateDot'
import { isExplicitAgentStatusFresh, agentTypeToIconAgent } from '@/lib/agent-status'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { cn } from '@/lib/utils'

// Why: this hovercard is intentionally self-contained in PR 3 (sidebar). The
// grouped Agent Dashboard (PR 4) will build its own view on top of the same
// store slice (`agentStatusByPaneKey` + `retainedAgentsByPaneKey`). Reading
// directly from the store here — rather than sharing a dashboard pipeline that
// doesn't exist yet — lets the sidebar ship independently and guarantees both
// PRs converge on the same source of truth without one depending on the other.
// When PR 4 lands, it will populate retainedAgentsByPaneKey via its retention
// sync effect; the union we build below already accounts for that, so no
// changes are needed here.

type AgentStatusHoverProps = {
  worktreeId: string
  children: React.ReactNode
}

type HoverAgentRow = {
  paneKey: string
  tabId: string
  entry: AgentStatusEntry
  dotState: AgentDotState
  isRetained: boolean
}

// Why: stale "working" entries (hook stream went silent past the freshness
// TTL) should appear as idle rather than spinning indefinitely. All other
// live states pass through 1:1 — AgentDotState is a superset of
// AgentStatusState so the cast is safe for fresh entries.
function liveEntryToDotState(entry: AgentStatusEntry, now: number): AgentDotState {
  if (!isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
    return 'idle'
  }
  return entry.state as AgentDotState
}

function truncatePrompt(value: string, max = 80): string {
  if (!value) {
    return ''
  }
  if (value.length <= max) {
    return value
  }
  return `${value.slice(0, max - 1).trimEnd()}…`
}

type InlineAgentRowProps = {
  row: HoverAgentRow
  onDismiss: (paneKey: string) => void
  onActivate: (tabId: string) => void
}

// Why: defined at module scope (memoized) rather than inside the hovercard so
// the row implementation is stable across re-renders and obviously shared
// between live and retained entries — the only difference between them for
// display purposes is the isRetained flag.
const InlineAgentRow = React.memo(function InlineAgentRow({
  row,
  onDismiss,
  onActivate
}: InlineAgentRowProps) {
  const { entry, dotState, isRetained, tabId, paneKey } = row
  const iconAgent = agentTypeToIconAgent(entry.agentType)
  const prompt = truncatePrompt(entry.prompt)
  const label = prompt || agentStateLabel(dotState)

  const handleActivateClick = useCallback(() => {
    onActivate(tabId)
  }, [onActivate, tabId])

  const handleDismissClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      // Why: the activate button sits next to this one inside a shared row
      // container (not a nested button — nesting <button> inside <button> is
      // invalid HTML and causes inconsistent click dispatch across browsers).
      // Still stop propagation defensively in case the row gains a click
      // handler in a future change.
      e.stopPropagation()
      onDismiss(paneKey)
    },
    [onDismiss, paneKey]
  )

  return (
    <div
      className={cn('group flex w-full items-center gap-2 rounded px-1 py-1', 'hover:bg-accent/60')}
    >
      <button
        type="button"
        onClick={handleActivateClick}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 text-left',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
        )}
        aria-label={`Activate ${entry.prompt || agentStateLabel(dotState)}`}
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          <AgentIcon agent={iconAgent} size={14} />
        </span>
        <AgentStateDot state={dotState} size="sm" />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-xs',
            isRetained ? 'text-muted-foreground' : 'text-foreground'
          )}
          title={entry.prompt || agentStateLabel(dotState)}
        >
          {label}
        </span>
      </button>
      <button
        type="button"
        aria-label="Dismiss agent"
        onClick={handleDismissClick}
        className={cn(
          'flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground/60',
          'opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent hover:text-foreground',
          'focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
        )}
      >
        <X className="size-3" />
      </button>
    </div>
  )
})

const AgentStatusHover = React.memo(function AgentStatusHover({
  worktreeId,
  children
}: AgentStatusHoverProps) {
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const agentStatusByPaneKey = useAppStore((s) => s.agentStatusByPaneKey)
  const retainedAgentsByPaneKey = useAppStore((s) => s.retainedAgentsByPaneKey)
  // Why: subscribe to the freshness epoch so the hovercard re-renders the
  // "idle" decay the moment an entry crosses AGENT_STATUS_STALE_AFTER_MS,
  // without needing a separate ticking timer in this component.
  const agentStatusEpoch = useAppStore((s) => s.agentStatusEpoch)
  const removeAgentStatus = useAppStore((s) => s.removeAgentStatus)
  const dismissRetainedAgent = useAppStore((s) => s.dismissRetainedAgent)
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const setActiveView = useAppStore((s) => s.setActiveView)

  const rows = useMemo<HoverAgentRow[]>(() => {
    const tabs = tabsByWorktree[worktreeId] ?? []
    if (tabs.length === 0 && Object.keys(retainedAgentsByPaneKey).length === 0) {
      return []
    }
    const tabIds = new Set(tabs.map((t) => t.id))
    const now = Date.now()
    const seen = new Set<string>()
    const collected: HoverAgentRow[] = []

    // Why: scan all live entries once, keep those whose paneKey prefix
    // (`${tabId}:`) matches a tab in this worktree. The paneKey format is
    // enforced by the store slice (`${tabId}:${paneId}`), so prefix matching
    // is the canonical lookup path without requiring an auxiliary index.
    for (const [paneKey, entry] of Object.entries(agentStatusByPaneKey)) {
      const sepIdx = paneKey.indexOf(':')
      if (sepIdx <= 0) {
        continue
      }
      const tabId = paneKey.slice(0, sepIdx)
      if (!tabIds.has(tabId)) {
        continue
      }
      collected.push({
        paneKey,
        tabId,
        entry,
        dotState: liveEntryToDotState(entry, now),
        isRetained: false
      })
      seen.add(paneKey)
    }

    // Why: merge in retained snapshots for this worktree. PR 3 has no
    // retention-sync hook yet, so this map is always empty here; the union
    // is preserved so PR 4 can auto-populate without touching this file.
    for (const [paneKey, retained] of Object.entries(retainedAgentsByPaneKey)) {
      if (retained.worktreeId !== worktreeId) {
        continue
      }
      if (seen.has(paneKey)) {
        continue
      }
      collected.push({
        paneKey,
        tabId: retained.tab.id,
        entry: retained.entry,
        // Why: retained entries are snapshots taken at completion time, so
        // their freshness is meaningful only relative to when they were
        // retained. Treat them uniformly as 'done' — the dashboard (PR 4)
        // will own any richer retained-state vocabulary.
        dotState: 'done',
        isRetained: true
      })
    }

    // Why: stable ordering — working first, then blocked/waiting, then done,
    // then idle. Within a state bucket, newer updates come first.
    const stateRank: Record<AgentDotState, number> = {
      working: 0,
      blocked: 1,
      waiting: 1,
      permission: 1,
      done: 2,
      idle: 3
    }
    collected.sort((a, b) => {
      const r = stateRank[a.dotState] - stateRank[b.dotState]
      if (r !== 0) {
        return r
      }
      return b.entry.updatedAt - a.entry.updatedAt
    })
    return collected
    // Why: agentStatusEpoch is a cache-busting counter, not data consumed by
    // the memo body. It bumps on entry writes AND on stale-boundary ticks
    // (see scheduleNextFreshnessExpiry in the agent-status slice), so listing
    // it forces recomputation of `dotState` when entries decay to 'idle' even
    // though agentStatusByPaneKey itself hasn't changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabsByWorktree, agentStatusByPaneKey, retainedAgentsByPaneKey, worktreeId, agentStatusEpoch])

  // Why: dismissing wipes both the live entry (if present) and the retained
  // snapshot (if present). In PR 3 only the live removal is reachable, but
  // keeping both calls here means PR 4's retention sync doesn't need to patch
  // this file.
  const handleDismissAgent = useCallback(
    (paneKey: string) => {
      removeAgentStatus(paneKey)
      dismissRetainedAgent(paneKey)
    },
    [removeAgentStatus, dismissRetainedAgent]
  )

  // Why: clicking a row activates the specific tab the agent runs in. Retained
  // rows can outlive their tab, so fall back to worktree-only activation when
  // the tab is no longer present.
  const handleActivateAgentTab = useCallback(
    (tabId: string) => {
      setActiveWorktree(worktreeId)
      setActiveView('terminal')
      const tabs = useAppStore.getState().tabsByWorktree[worktreeId] ?? []
      if (tabs.some((t) => t.id === tabId)) {
        setActiveTab(tabId)
      }
    },
    [worktreeId, setActiveWorktree, setActiveTab, setActiveView]
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
            <div className="flex flex-col divide-y divide-border/60">
              {rows.map((row) => (
                <div key={row.paneKey} className="py-1">
                  <InlineAgentRow
                    row={row}
                    onDismiss={handleDismissAgent}
                    onActivate={handleActivateAgentTab}
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </HoverCardContent>
    </HoverCard>
  )
})

export default AgentStatusHover
