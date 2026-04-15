import React from 'react'
import { cn } from '@/lib/utils'
import { formatAgentTypeLabel } from '@/lib/agent-status'
import type { DashboardAgentRow as DashboardAgentRowData } from './useDashboardData'

function currentDotClasses(state: string): string {
  switch (state) {
    case 'working':
      return 'bg-emerald-500'
    case 'blocked':
    case 'waiting':
      return 'bg-amber-500 animate-pulse'
    case 'done':
      return 'bg-sky-500/70'
    case 'idle':
    default:
      return 'bg-zinc-400/40'
  }
}

function stateLabel(state: string): string {
  switch (state) {
    case 'working':
      return 'Working'
    case 'blocked':
      return 'Blocked'
    case 'waiting':
      return 'Waiting'
    case 'done':
      return 'Done'
    case 'idle':
      return 'Idle'
    default:
      return state
  }
}

function stateLabelColor(state: string): string {
  switch (state) {
    case 'working':
      return 'text-emerald-500'
    case 'blocked':
    case 'waiting':
      return 'text-amber-500'
    case 'done':
      return 'text-sky-500/80'
    default:
      return 'text-zinc-500'
  }
}

type Props = {
  agent: DashboardAgentRowData
}

const DashboardAgentRow = React.memo(function DashboardAgentRow({ agent }: Props) {
  const agentLabel = formatAgentTypeLabel(agent.agentType)

  return (
    <div
      className={cn(
        'rounded px-1.5 py-1 bg-background/30',
        agent.source === 'heuristic' && 'opacity-70'
      )}
    >
      {/* Top line: agent label + current state */}
      <div className="flex items-center gap-1.5">
        {/* Status dot */}
        <span className={cn('size-[6px] shrink-0 rounded-full', currentDotClasses(agent.state))} />
        {/* Agent type */}
        <span className="text-[10px] font-medium text-foreground/80">{agentLabel}</span>
        {/* State label */}
        <span className={cn('text-[10px] font-medium', stateLabelColor(agent.state))}>
          {stateLabel(agent.state)}
        </span>
      </div>
    </div>
  )
})

export default DashboardAgentRow
