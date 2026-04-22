import React, { useEffect, useState, useCallback } from 'react'
import { X, Wrench, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { AgentStateDot, agentStateLabel, type AgentDotState } from '@/components/AgentStateDot'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
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

  // Why: any state the user still needs to act on gets a full-height left
  // accent bar — blocked/waiting (red, needs input) and done (sky, needs
  // review). The bar is the list-view convention (Linear, Jira, GitHub) for
  // "this row wants attention"; color communicates *what kind* of attention.
  // Red matches the workspace sidebar's permission dot so the two surfaces
  // agree on what "needs input" looks like. Working/idle rows get no bar so
  // the list scans cleanly to the things that actually need the user.
  const accentColor =
    agent.state === 'blocked' || agent.state === 'waiting'
      ? 'bg-red-500'
      : agent.state === 'done'
        ? 'bg-sky-500/80'
        : null

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleActivate}
      onKeyDown={handleActivateKeyDown}
      className={cn(
        'group relative flex flex-col pl-1 pr-1.5 py-0.5',
        // Why: hover tints have to go in opposite directions per theme —
        // dark mode adds light on dark (bg-accent/30), light mode needs to
        // add *dark* on white. Alpha-on-accent in light mode collapses to
        // near-nothing because accent (#f5f5f5) is already ~white. Use a
        // black alpha overlay in light mode (mirrors WorktreeCard.tsx's
        // active-state pattern) so the lift is symmetric across themes.
        'cursor-pointer rounded-sm hover:bg-black/[0.06] dark:hover:bg-accent/30',
        'focus-visible:outline-none focus-visible:bg-black/[0.09] dark:focus-visible:bg-accent/40'
      )}
      title={tsParts.length > 0 ? tsParts.join(' • ') : undefined}
    >
      {accentColor && (
        <span
          className={cn('absolute inset-y-0 left-0 w-0.5 rounded-full', accentColor)}
          aria-hidden
        />
      )}
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
            {/* Why: rotating a single chevron animates smoothly; swapping
                between two separate glyphs (ChevronRight/ChevronDown) would
                snap instantly because the old node unmounts. */}
            <ChevronRight
              className={cn('size-3.5 transition-transform duration-150', expanded && 'rotate-90')}
            />
          </button>
        ) : (
          <span className="inline-block size-3.5 shrink-0" aria-hidden />
        )}
        {prompt && (
          // Why: animate between a 1-line clipped height and the content's
          // natural height using Chromium's `interpolate-size: allow-keywords`
          // — this is the only way to transition a `height` property to/from
          // `auto` without measuring sizes in JS. Falls back to an instant
          // swap in engines that don't support it. The inner span keeps
          // overflow-hidden so the truncate→wrap class flip stays clipped
          // during the interpolation.
          <span
            className={cn(
              'block min-w-0 flex-1 overflow-hidden text-[11px] font-medium leading-snug text-foreground/90',
              'transition-[height] duration-200 ease-out [interpolate-size:allow-keywords]',
              expanded ? 'h-auto whitespace-pre-wrap break-words' : 'h-[1lh] truncate'
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
      {/* Why: tool row and message row both carry different info — tool shows
          the mechanical step (Bash: ...), message shows the agent's narration
          ("let me verify the test ordering"). Rendering both together would
          cause the row to jump whenever one appeared/disappeared mid-turn,
          so instead we always render both slots and fall back to a single-line
          placeholder when empty. Tool slot only reserves height while working,
          since done/blocked rows shouldn't show a dangling wrench. */}
      {isWorking && (
        <div className="mt-0.5 min-w-0 pl-5 text-[10px] leading-snug text-muted-foreground/70">
          {toolName ? (
            <>
              {/* Why: header (wrench + tool name) stays on one line. When
                  collapsed, the input truncates inline next to the name. When
                  expanded, the input moves to its own block below so long
                  commands wrap to a consistent left margin instead of the
                  jagged shape that flex-wrapping produces. */}
              <div
                className={cn('flex min-w-0 items-center gap-1', !expanded && 'overflow-hidden')}
              >
                <Wrench className="size-2.5 shrink-0" />
                <code className="shrink-0 font-mono text-[10px]">{toolName}</code>
                {!expanded && toolInput && (
                  <span className="min-w-0 truncate text-muted-foreground/60" title={toolInput}>
                    {toolInput}
                  </span>
                )}
              </div>
              {/* Why: grid-rows [0fr]→[1fr] is the CSS-only height animation
                  pattern — outer grid track interpolates smoothly while the
                  inner min-h-0 + overflow-hidden clips content during the
                  transition. This avoids measuring heights in JS and still
                  animates unknown content sizes. */}
              {toolInput && (
                <div
                  className={cn(
                    'grid transition-[grid-template-rows,margin-top] duration-200 ease-out',
                    expanded ? 'mt-0.5 grid-rows-[1fr]' : 'grid-rows-[0fr]'
                  )}
                >
                  <pre className="min-h-0 overflow-hidden whitespace-pre-wrap break-words font-mono text-[10px] text-muted-foreground/60">
                    {toolInput}
                  </pre>
                </div>
              )}
            </>
          ) : (
            ' '
          )}
        </div>
      )}
      {/* Why: message slot is always reserved in collapsed view so the row
          height stays fixed as lastAssistantMessage arrives/clears. The
          expand animation lives on the CommentMarkdown itself (height +
          interpolate-size) so the body reveals smoothly instead of snapping
          open. When the message is empty we still render a placeholder in
          the collapsed view to preserve the reserved line height. */}
      {lastAssistantMessage ? (
        <CommentMarkdown
          content={lastAssistantMessage}
          // Why: animate between a 1-line clipped height and the content's
          // natural height using Chromium's `interpolate-size: allow-keywords`
          // so the message body expands/collapses smoothly instead of
          // snapping. Height transition + overflow-hidden keeps the inline-
          // flattened preview clipped during the interpolation. Render the
          // markdown in both states; in the collapsed view we force every
          // nested element inline so `truncate` can ellipsize the whole
          // thing on one line. The [&_*]:inline descendant selector flattens
          // the markdown tree (lists, pre, headings, blockquotes) into inline
          // flow; block margins and list markers are suppressed by
          // [&_*]:!m-0 / [&_ul]:list-none so the preview reads as a single
          // clean line.
          className={cn(
            'mt-0.5 overflow-hidden pl-5 text-[10px] leading-snug text-muted-foreground/80',
            'transition-[height] duration-200 ease-out [interpolate-size:allow-keywords]',
            expanded ? 'h-auto' : 'h-[1lh]',
            // Why: in collapsed mode we need a single truncated line. Markdown
            // blocks (pre, lists, headings) are flattened inline and forced
            // to inherit `white-space: nowrap` so <pre>/<code>'s preserved
            // newlines don't break out of the truncation container. The
            // `!` prefixes override CommentMarkdown's own layout styles so
            // nothing (margins, list markers, block line-breaks) can push
            // the preview onto a second line.
            !expanded &&
              'truncate whitespace-nowrap [&_*]:inline [&_*]:!whitespace-nowrap [&_*]:!m-0 [&_*]:!p-0 [&_ul]:list-none [&_ol]:list-none [&_br]:hidden'
          )}
          title={!expanded ? lastAssistantMessage : undefined}
        />
      ) : (
        !expanded && (
          <div className="mt-0.5 pl-5 text-[10px] leading-snug text-muted-foreground/70"> </div>
        )
      )}
    </div>
  )
})

export default DashboardAgentRow
