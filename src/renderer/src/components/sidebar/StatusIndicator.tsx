import React from 'react'
import { cn } from '@/lib/utils'

export type Status = 'active' | 'working' | 'permission' | 'done' | 'inactive'

type StatusIndicatorProps = {
  status: Status
  className?: string
}

const StatusIndicator = React.memo(function StatusIndicator({
  status,
  className
}: StatusIndicatorProps) {
  if (status === 'working') {
    return (
      <span className={cn('inline-flex h-3 w-3 shrink-0 items-center justify-center', className)}>
        <span className="block size-2 rounded-full border-2 border-emerald-500 border-t-transparent animate-spin" />
      </span>
    )
  }

  return (
    <span className={cn('inline-flex h-3 w-3 shrink-0 items-center justify-center', className)}>
      <span
        className={cn(
          'block size-2 rounded-full',
          status === 'active'
            ? 'bg-emerald-500'
            : status === 'permission'
              ? 'bg-red-500'
              : status === 'done'
                ? // Why: sky-500/80 matches the dashboard AgentStateDot's
                  // `done` color so the two surfaces read as the same state.
                  'bg-sky-500/80'
                : 'bg-neutral-500/40'
        )}
      />
    </span>
  )
})

export default StatusIndicator
