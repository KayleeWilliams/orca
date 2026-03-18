import React from 'react'
import { FolderPlus, Settings } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'

const SidebarToolbar = React.memo(function SidebarToolbar() {
  const addRepo = useAppStore((s) => s.addRepo)
  const setActiveView = useAppStore((s) => s.setActiveView)

  return (
    <div className="mt-auto flex items-center justify-between px-2 py-1.5 border-t border-sidebar-border shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="xs"
              onClick={() => addRepo()}
              className="gap-1.5 text-muted-foreground"
            >
              <FolderPlus className="size-3.5" />
              <span className="text-[11px]">Add Repo</span>
            </Button>
          }
        />
        <TooltipContent side="top" sideOffset={4}>
          Open folder picker to add a repo
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <Button
          render={<TooltipTrigger />}
          variant="ghost"
          size="icon-xs"
          onClick={() => setActiveView('settings')}
          className="text-muted-foreground"
        >
          <Settings className="size-3.5" />
        </Button>
        <TooltipContent side="top" sideOffset={4}>
          Settings
        </TooltipContent>
      </Tooltip>
    </div>
  )
})

export default SidebarToolbar
