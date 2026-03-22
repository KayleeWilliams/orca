import React from 'react'
import { Download, FolderPlus, Settings } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'

const SidebarToolbar = React.memo(function SidebarToolbar() {
  const addRepo = useAppStore((s) => s.addRepo)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const updateStatus = useAppStore((s) => s.updateStatus)

  const showUpdateBanner =
    updateStatus.state === 'downloaded' || updateStatus.state === 'available'

  return (
    <div className="mt-auto shrink-0">
      {showUpdateBanner && (
        <button
          onClick={() =>
            updateStatus.state === 'downloaded'
              ? window.api.updater.quitAndInstall()
              : undefined
          }
          className="flex items-center gap-1.5 w-full px-2 py-1.5 text-[11px] font-medium text-primary bg-primary/10 hover:bg-primary/15 transition-colors cursor-pointer border-t border-sidebar-border"
        >
          <Download className="size-3.5 shrink-0" />
          {updateStatus.state === 'downloaded' ? (
            <span>Restart now (update)</span>
          ) : (
            <span>
              Downloading <span className="font-semibold">v{updateStatus.version}</span>…
            </span>
          )}
        </button>
      )}
      <div className="flex items-center justify-between px-2 py-1.5 border-t border-sidebar-border">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => addRepo()}
              className="gap-1.5 text-muted-foreground"
            >
              <FolderPlus className="size-3.5" />
              <span className="text-[11px]">Add Repo</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            Open folder picker to add a repo
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setActiveView('settings')}
              className="text-muted-foreground"
            >
              <Settings className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            Settings
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
})

export default SidebarToolbar
