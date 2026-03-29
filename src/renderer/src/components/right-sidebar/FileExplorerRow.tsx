import React from 'react'
import { ChevronRight, File, Folder, FolderOpen, Loader2, Trash2 } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuShortcut,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'
import type { GitFileStatus } from '../../../../shared/types'
import { STATUS_LABELS } from './status-display'
import type { TreeNode } from './file-explorer-types'

type FileExplorerRowProps = {
  node: TreeNode
  isExpanded: boolean
  isLoading: boolean
  isSelected: boolean
  isFlashing: boolean
  nodeStatus: GitFileStatus | null
  statusColor: string | null
  deleteShortcutLabel: string
  onClick: () => void
  onDoubleClick: () => void
  onSelect: () => void
  onRequestDelete: () => void
}

export function FileExplorerRow({
  node,
  isExpanded,
  isLoading,
  isSelected,
  isFlashing,
  nodeStatus,
  statusColor,
  deleteShortcutLabel,
  onClick,
  onDoubleClick,
  onSelect,
  onRequestDelete
}: FileExplorerRowProps): React.JSX.Element {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          className={cn(
            'flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left text-xs transition-colors hover:bg-accent/60',
            isSelected && 'bg-accent text-accent-foreground',
            isFlashing && 'bg-amber-400/20 ring-1 ring-inset ring-amber-400/70'
          )}
          style={{ paddingLeft: `${node.depth * 16 + 8}px` }}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData('text/x-orca-file-path', node.path)
            event.dataTransfer.effectAllowed = 'copy'
          }}
          onClick={onClick}
          onDoubleClick={onDoubleClick}
          onFocus={onSelect}
          onContextMenu={onSelect}
        >
          {node.isDirectory ? (
            <>
              <ChevronRight
                className={cn(
                  'size-3 shrink-0 text-muted-foreground transition-transform',
                  isExpanded && 'rotate-90'
                )}
              />
              {isLoading ? (
                <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
              ) : isExpanded ? (
                <FolderOpen className="size-3 shrink-0 text-muted-foreground" />
              ) : (
                <Folder className="size-3 shrink-0 text-muted-foreground" />
              )}
            </>
          ) : (
            <>
              <span className="size-3 shrink-0" />
              <File className="size-3 shrink-0 text-muted-foreground" />
            </>
          )}
          <span
            className={cn('truncate', isSelected && !nodeStatus && 'text-accent-foreground')}
            style={nodeStatus ? { color: statusColor ?? undefined } : undefined}
          >
            {node.name}
          </span>
          {nodeStatus && (
            <span
              className="ml-auto shrink-0 text-[10px] font-semibold tracking-wide"
              style={{ color: statusColor ?? undefined }}
            >
              {STATUS_LABELS[nodeStatus]}
            </span>
          )}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem onSelect={onRequestDelete}>
          <Trash2 className="size-3.5" />
          Delete
          <ContextMenuShortcut>{deleteShortcutLabel}</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
