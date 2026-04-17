import React from 'react'
import { Plus, SlidersHorizontal } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { getTaskPresetQuery } from '@/lib/new-workspace'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem
} from '@/components/ui/dropdown-menu'
import type { WorktreeCardProperty } from '../../../../shared/types'

const PROPERTY_OPTIONS: { id: WorktreeCardProperty; label: string }[] = [
  { id: 'status', label: 'Terminal status' },
  { id: 'unread', label: 'Unread indicator' },
  { id: 'ci', label: 'CI checks' },
  { id: 'issue', label: 'Linked issue' },
  { id: 'pr', label: 'Linked PR' },
  { id: 'comment', label: 'Comment' }
]

const SORT_OPTIONS = [
  { id: 'name', label: 'Name' },
  { id: 'smart', label: 'Smart' },
  { id: 'recent', label: 'Recent' },
  { id: 'repo', label: 'Repo' }
] as const

const isMac = navigator.userAgent.includes('Mac')
const newWorktreeShortcutLabel = isMac ? '⌘N' : 'Ctrl+N'

const SidebarHeader = React.memo(function SidebarHeader() {
  const openNewWorkspacePage = useAppStore((s) => s.openNewWorkspacePage)
  const repos = useAppStore((s) => s.repos)
  const canCreateWorktree = repos.some((repo) => isGitRepoKind(repo))

  const worktreeCardProperties = useAppStore((s) => s.worktreeCardProperties)
  const toggleWorktreeCardProperty = useAppStore((s) => s.toggleWorktreeCardProperty)
  const sortBy = useAppStore((s) => s.sortBy)
  const setSortBy = useAppStore((s) => s.setSortBy)

  // Why: start warming the GitHub work-item cache on hover/focus/pointerdown so
  // by the time the user's click finishes the round-trip has either completed
  // or is already in-flight. Shaves ~200–600ms off perceived page-load latency.
  const prefetchWorkItems = useAppStore((s) => s.prefetchWorkItems)
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const defaultTaskViewPreset = useAppStore((s) => s.settings?.defaultTaskViewPreset ?? 'all')
  const handlePrefetch = React.useCallback(() => {
    if (!canCreateWorktree) {
      return
    }
    const activeRepo = repos.find((r) => r.id === activeRepoId && isGitRepoKind(r))
    const firstGitRepo = activeRepo ?? repos.find((r) => isGitRepoKind(r))
    if (firstGitRepo?.path) {
      // Why: warm the exact cache key the page will read on mount — must
      // match NewWorkspacePage's `initialTaskQuery` derived from the same
      // default preset, otherwise the prefetch lands in a key the page
      // never reads and we pay the full round-trip after click.
      prefetchWorkItems(firstGitRepo.path, 36, getTaskPresetQuery(defaultTaskViewPreset))
    }
  }, [activeRepoId, canCreateWorktree, defaultTaskViewPreset, prefetchWorkItems, repos])

  return (
    <div className="flex items-center justify-between px-4 pt-3 pb-1">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground select-none">
        Workspaces
      </span>
      <div className="flex items-center gap-1.5 shrink-0">
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground"
                  aria-label="View options"
                >
                  <SlidersHorizontal className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              View options
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-56 pb-2">
            <DropdownMenuLabel>Sort by</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={sortBy}
              onValueChange={(v) => setSortBy(v as typeof sortBy)}
            >
              {SORT_OPTIONS.map((opt) => (
                <DropdownMenuRadioItem
                  key={opt.id}
                  value={opt.id}
                  // Keep the menu open so people can compare sort modes and
                  // toggle card properties without reopening the same panel.
                  onSelect={(e) => e.preventDefault()}
                >
                  {opt.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>

            <DropdownMenuSeparator />
            <DropdownMenuLabel>Show properties</DropdownMenuLabel>
            {PROPERTY_OPTIONS.map((opt) => (
              <DropdownMenuCheckboxItem
                key={opt.id}
                checked={worktreeCardProperties.includes(opt.id)}
                onCheckedChange={() => toggleWorktreeCardProperty(opt.id)}
                onSelect={(e) => e.preventDefault()}
              >
                {opt.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => {
                if (!canCreateWorktree) {
                  return
                }
                openNewWorkspacePage()
              }}
              onPointerEnter={handlePrefetch}
              onFocus={handlePrefetch}
              aria-label="Add worktree"
              disabled={!canCreateWorktree}
            >
              <Plus className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={6}>
            {canCreateWorktree
              ? `New workspace (${newWorktreeShortcutLabel})`
              : 'Add a Git repo to create worktrees'}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
})

export default SidebarHeader
