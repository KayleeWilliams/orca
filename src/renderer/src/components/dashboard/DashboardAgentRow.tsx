import React, { useEffect, useState, useCallback } from 'react'
import { X, Wrench, ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { AgentStateDot, agentStateLabel, type AgentDotState } from '@/components/AgentStateDot'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import type { DashboardAgentRow as DashboardAgentRowData } from './useDashboardData'

// Why: the dashboard tracks its own rollup states (incl. 'idle'); narrow to the
// shared dot states for rendering, falling back to 'idle' for any unknown
// value so an unexpected state never crashes a row.
function asDotState(state: string): AgentDotState {
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
  const [expanded, setExpanded] = useState(false)
  // Why: stop propagation so clicking the X doesn't also fire the worktree
  // card's click handler (which navigates away from the dashboard).
  const handleDismiss = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onDismiss(agent.paneKey)
    },
    [onDismiss, agent.paneKey]
  )
  // Why: the chevron toggles expand-collapse and must not propagate — clicks
  // on it would otherwise bubble to the row's activate handler and navigate
  // away the instant the user tried to reveal the full text. Stop mousedown
  // too so focus-based navigation on the parent role=button can't fire first.
  const handleToggleExpand = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setExpanded((prev) => !prev)
  }, [])
  const stopMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
  }, [])
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
  const prompt = agent.entry.prompt.trim()
  // Why: the tool row describes what the agent is *currently* doing; once it
  // leaves working, that line goes stale and misleads (a done row showing
  // "Bash: pnpm test" reads as if the command is still running). Gate tool
  // fields on `state === 'working'`. The assistant message is the opposite
  // — it's the reply, most useful on `done`, so we always show it.
  const isWorking = agent.state === 'working'
  const toolName = isWorking ? (agent.entry.toolName?.trim() ?? '') : ''
  const toolInput = isWorking ? (agent.entry.toolInput?.trim() ?? '') : ''
  const lastAssistantMessage = agent.entry.lastAssistantMessage?.trim() ?? ''

  const canExpand = prompt.length > 0 || lastAssistantMessage.length > 0

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
        'group flex flex-col px-1.5 py-0.5',
        'cursor-pointer rounded-sm hover:bg-accent/30',
        'focus-visible:outline-none focus-visible:bg-accent/40'
      )}
      title={tsParts.length > 0 ? tsParts.join(' • ') : undefined}
    >
      <div className="flex items-center gap-1.5">
        {/* Why: chevron on the far left mirrors the disclosure-row pattern
            (Mantine Collapse, Playwright's test tree, etc.) — users reach
            for the left edge to expand/collapse. An invisible placeholder
            fills the slot when nothing's expandable so the prompt text
            stays vertically aligned across rows. */}
        {canExpand ? (
          <button
            type="button"
            onClick={handleToggleExpand}
            onMouseDown={stopMouseDown}
            className="inline-flex shrink-0 items-center justify-center text-muted-foreground/60 hover:text-foreground"
            aria-label={expanded ? 'Collapse details' : 'Expand details'}
            aria-expanded={expanded}
          >
            {expanded ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </button>
        ) : (
          <span className="inline-block size-3.5 shrink-0" aria-hidden />
        )}
        {prompt && (
          <span
            className={cn(
              'min-w-0 flex-1 text-xs font-medium leading-snug text-foreground/90',
              expanded ? 'whitespace-pre-wrap break-words' : 'truncate'
            )}
            title={expanded ? undefined : prompt}
          >
            {prompt}
          </span>
        )}
        {/* Why: right cluster mirrors the screenshot reference — the status
            indicator (state dot), identity (agent icon), a muted timestamp,
            and the dismiss-X all live in one flex group on the right so
            the eye can find "who/what/when/close" in a single sweep. */}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {/* Why: call out cancellations explicitly — a `done` that was
              interrupted looks visually identical to a clean finish without a
              label, but the user cares a lot about the difference (their turn
              didn't complete). The tag sits before the timestamp so it reads
              as a qualifier on "done 3m ago". */}
          {agent.entry.interrupted && (
            <span className="rounded-sm bg-rose-500/15 px-1 py-px text-[9px] font-medium leading-none text-rose-400/90">
              interrupted
            </span>
          )}
          {(startedAt !== null || doneAt !== null) && (
            <span className="text-[10px] leading-none text-muted-foreground/60">
              {doneAt !== null
                ? formatTimeAgo(doneAt, now)
                : startedAt !== null
                  ? formatTimeAgo(startedAt, now)
                  : null}
            </span>
          )}
          {/* Why: two separate glyphs — the state dot shows *what* (working /
              blocked / done / idle) and the agent icon shows *who* (Claude /
              Codex / etc.). Keeping them distinct keeps each scannable at a
              glance, instead of fusing them into a single decorated icon. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <AgentStateDot state={asDotState(agent.state)} />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {agent.entry.interrupted ? 'Interrupted' : agentStateLabel(asDotState(agent.state))}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <AgentIcon agent={agentTypeToIconAgent(agent.agentType)} size={14} />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {formatAgentTypeLabel(agent.agentType)}
            </TooltipContent>
          </Tooltip>
          {/* Why: dismiss applies to any agent — for a live agent it clears
              the status entry (the dashboard re-populates on the next hook
              report); for a retained 'done' row it evicts it from the
              retained map. Same control for every state keeps the UI
              uniform. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleDismiss}
                onMouseDown={stopMouseDown}
                className="inline-flex shrink-0 items-center justify-center text-muted-foreground/70 hover:text-foreground"
                aria-label="Dismiss agent"
              >
                <X className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              Dismiss
            </TooltipContent>
          </Tooltip>
        </span>
      </div>
      {toolName && (
        <div
          className={cn(
            'mt-1 flex min-w-0 gap-1 pl-5 text-[11px] leading-snug text-muted-foreground/70',
            expanded ? 'items-start' : 'items-center'
          )}
        >
          <Wrench className="mt-[2px] size-2.5 shrink-0" />
          <code className="shrink-0 font-mono text-[11px]">{toolName}</code>
          {toolInput && (
            <span
              className={cn(
                'min-w-0 text-muted-foreground/60',
                expanded ? 'whitespace-pre-wrap break-words' : 'truncate'
              )}
              title={expanded ? undefined : toolInput}
            >
              {toolInput}
            </span>
          )}
        </div>
      )}
      {/* Why: reserve the message row's height in collapsed view even when
          empty, so the card doesn't shift vertically as lastAssistantMessage
          arrives or clears mid-turn. When expanded we only render if there's
          content — a blank reserved slot inside an already-expanded card
          would read as a visible gap. */}
      {(lastAssistantMessage || !expanded) && (
        <div
          className={cn(
            'mt-1 pl-5 text-[11px] italic leading-snug text-muted-foreground/70',
            expanded ? 'whitespace-pre-wrap break-words' : 'truncate'
          )}
          title={!expanded && lastAssistantMessage ? lastAssistantMessage : undefined}
        >
          {lastAssistantMessage || ' '}
        </div>
      )}
    </div>
  )
})

export default DashboardAgentRow
