import React from 'react'
import { cn } from '@/lib/utils'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import type { AgentType } from '../../../shared/agent-status-types'

// Why: single shared primitive for rendering an agent in a list. The agent
// icon *is* the status indicator — state is conveyed by a colored ring and
// optional animation around the icon, not by a separate dot. The tooltip
// surfaces both the agent name and its current state so hover gives full
// attribution without consuming horizontal space in the row.

export type AgentStatusBadgeState =
  | 'working'
  | 'blocked'
  | 'waiting'
  | 'done'
  | 'idle'
  // Why: heuristic rows derived from terminal titles only distinguish "needs
  // attention" as a single state; render it the same as `blocked`.
  | 'permission'

function stateLabel(state: AgentStatusBadgeState): string {
  switch (state) {
    case 'working':
      return 'Working'
    case 'blocked':
      return 'Blocked'
    case 'waiting':
      return 'Waiting for input'
    case 'done':
      return 'Done'
    case 'idle':
      return 'Idle'
    case 'permission':
      return 'Needs attention'
  }
}

// Why: for non-spinning states the ring is just a solid outline on the
// wrapper. Working is handled separately below (spinning arc overlay) because
// a full solid ring with `animate-spin` would look static — there's no visible
// rotation without an asymmetry in the stroke.
function staticRingClasses(state: AgentStatusBadgeState): string {
  switch (state) {
    case 'blocked':
    case 'waiting':
    case 'permission':
      return 'ring-2 ring-amber-500 ring-inset animate-pulse'
    case 'done':
      return 'ring-2 ring-sky-500/70 ring-inset'
    case 'idle':
      return 'ring-1 ring-zinc-400/30 ring-inset'
    case 'working':
      return '' // handled by overlay
  }
}

type Props = {
  agentType: AgentType | null | undefined
  state: AgentStatusBadgeState
  size?: number
  className?: string
}

export const AgentStatusBadge = React.memo(function AgentStatusBadge({
  agentType,
  state,
  size = 12,
  className
}: Props): React.JSX.Element {
  const iconAgent = agentTypeToIconAgent(agentType)
  const agentLabel = formatAgentTypeLabel(agentType)
  const tooltip = `${agentLabel} — ${stateLabel(state)}`

  // Why: the ring sits on a padded wrapper (not the icon itself) so the
  // visible gap between icon and ring is consistent regardless of icon size.
  // Total box is size + 2*padding; the working overlay matches that box.
  const padding = Math.max(2, Math.round(size / 6))
  const box = size + padding * 2

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'relative inline-flex shrink-0 items-center justify-center rounded-full',
            staticRingClasses(state),
            className
          )}
          style={{ padding, width: box, height: box }}
          aria-label={tooltip}
        >
          <AgentIcon agent={iconAgent} size={size} />
          {state === 'working' && (
            // Why: a spinning arc around the icon. The ring has a colored top
            // border and transparent bottom so rotation is visible; inset keeps
            // the arc aligned with the outline used by the other states.
            <span
              className="pointer-events-none absolute inset-0 rounded-full border-2 border-transparent border-t-emerald-500 animate-spin"
              aria-hidden
            />
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
})
