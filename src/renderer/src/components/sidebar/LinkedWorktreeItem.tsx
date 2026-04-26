import type { Worktree } from '../../../../shared/types'

export function LinkedWorktreeItem({
  worktree,
  onOpen
}: {
  worktree: Worktree
  onOpen: () => void
}): React.JSX.Element {
  const branchLabel = worktree.branch.replace(/^refs\/heads\//, '')

  return (
    <button
      className="group flex items-center justify-between gap-3 w-full rounded-md border border-border/60 bg-secondary/30 px-3 py-2 text-left transition-colors hover:bg-accent cursor-pointer"
      onClick={onOpen}
    >
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{worktree.displayName}</p>
        {branchLabel !== worktree.displayName && (
          <p className="text-xs text-muted-foreground truncate mt-0.5">{branchLabel}</p>
        )}
      </div>
      <span className="shrink-0 text-xs font-medium text-muted-foreground group-hover:text-foreground transition-colors">
        Open
      </span>
    </button>
  )
}
