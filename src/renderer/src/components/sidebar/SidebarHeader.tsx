import React from 'react'
import { Plus } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'

const SidebarHeader = React.memo(function SidebarHeader() {
  const openModal = useAppStore((s) => s.openModal)

  return (
    <div className="flex items-center justify-between px-4 pt-3 pb-1">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground select-none">
        Worktrees
      </span>
      <Tooltip>
        <Button
          render={<TooltipTrigger />}
          variant="ghost"
          size="icon-xs"
          onClick={() => openModal('create-worktree')}
          aria-label="Add worktree"
        >
          <Plus className="size-3.5" />
        </Button>
        <TooltipContent side="right" sideOffset={6}>
          New worktree
        </TooltipContent>
      </Tooltip>
    </div>
  )
})

export default SidebarHeader
