import React, { useEffect, useMemo, useRef, useCallback } from 'react'
import { useAppStore } from '@/store'
import { Badge } from '@/components/ui/badge'
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card'
import RepoDotLabel from '@/components/repo/RepoDotLabel'
import StatusIndicator from './StatusIndicator'
import WorktreeContextMenu from './WorktreeContextMenu'
import { cn } from '@/lib/utils'
import { detectAgentStatusFromTitle } from '@/lib/agent-status'
import type {
  Worktree,
  Repo,
  PRInfo,
  IssueInfo,
  PRState,
  CheckStatus,
  TerminalTab
} from '../../../../shared/types'
import type { Status } from './StatusIndicator'

function branchDisplayName(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

const PRIMARY_BRANCHES = new Set(['main', 'master', 'develop', 'dev'])

function isPrimaryBranch(branch: string): boolean {
  return PRIMARY_BRANCHES.has(branchDisplayName(branch))
}

function prStateLabel(state: PRState): string {
  return state.charAt(0).toUpperCase() + state.slice(1)
}

function checksLabel(status: CheckStatus): string {
  switch (status) {
    case 'success':
      return 'Passing'
    case 'failure':
      return 'Failing'
    case 'pending':
      return 'Pending'
    default:
      return ''
  }
}

// ── Stable empty array for tabs fallback ─────────────────────────
const EMPTY_TABS: TerminalTab[] = []

interface WorktreeCardProps {
  worktree: Worktree
  repo: Repo | undefined
  isActive: boolean
}

const WorktreeCard = React.memo(function WorktreeCard({
  worktree,
  repo,
  isActive
}: WorktreeCardProps) {
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const fetchPRForBranch = useAppStore((s) => s.fetchPRForBranch)
  const fetchIssue = useAppStore((s) => s.fetchIssue)

  // ── GRANULAR selectors: only subscribe to THIS worktree's data ──
  const tabs = useAppStore((s) => s.tabsByWorktree[worktree.id] ?? EMPTY_TABS)

  const branch = branchDisplayName(worktree.branch)
  const prCacheKey = repo ? `${repo.path}::${branch}` : ''
  const issueCacheKey = repo && worktree.linkedIssue ? `${repo.path}::${worktree.linkedIssue}` : ''

  // Subscribe to ONLY the specific cache entry, not entire prCache/issueCache
  const prEntry = useAppStore((s) => (prCacheKey ? s.prCache[prCacheKey] : undefined))
  const issueEntry = useAppStore((s) => (issueCacheKey ? s.issueCache[issueCacheKey] : undefined))

  const pr: PRInfo | null | undefined = prEntry !== undefined ? prEntry.data : undefined
  const issue: IssueInfo | null | undefined = worktree.linkedIssue
    ? issueEntry !== undefined
      ? issueEntry.data
      : undefined
    : null

  const hasTerminals = tabs.length > 0

  // Derive status
  const status: Status = useMemo(() => {
    if (!hasTerminals) return 'inactive'
    if (tabs.some((t) => detectAgentStatusFromTitle(t.title) === 'permission')) return 'permission'
    if (tabs.some((t) => detectAgentStatusFromTitle(t.title) === 'working')) return 'working'
    return tabs.some((t) => t.ptyId) ? 'active' : 'inactive'
  }, [hasTerminals, tabs])

  // Fetch PR data (debounced via ref guard)
  const prFetchedRef = useRef<string | null>(null)
  useEffect(() => {
    if (
      repo &&
      !worktree.isBare &&
      pr === undefined &&
      prCacheKey &&
      prCacheKey !== prFetchedRef.current
    ) {
      prFetchedRef.current = prCacheKey
      fetchPRForBranch(repo.path, branch)
    }
  }, [repo, worktree.isBare, pr, fetchPRForBranch, branch, prCacheKey])

  // Fetch issue data (debounced via ref guard)
  const issueFetchedRef = useRef<string | null>(null)
  useEffect(() => {
    if (
      repo &&
      worktree.linkedIssue &&
      issue === undefined &&
      issueCacheKey &&
      issueCacheKey !== issueFetchedRef.current
    ) {
      issueFetchedRef.current = issueCacheKey
      fetchIssue(repo.path, worktree.linkedIssue)
    }
  }, [repo, worktree.linkedIssue, issue, fetchIssue, issueCacheKey])

  // Stable click handler
  const handleClick = useCallback(
    () => setActiveWorktree(worktree.id),
    [worktree.id, setActiveWorktree]
  )

  return (
    <WorktreeContextMenu worktree={worktree}>
      <div
        className={cn(
          'group relative flex items-start gap-2 px-2.5 py-1.5 rounded-md cursor-pointer transition-colors',
          isActive ? 'bg-accent' : 'hover:bg-accent/50'
        )}
        onClick={handleClick}
      >
        {/* Status + unread indicator */}
        <div className="flex items-center pt-1 gap-1">
          <StatusIndicator status={status} />
          {worktree.isUnread && (
            <span className="block size-1.5 rounded-full bg-foreground/70 shrink-0" />
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 space-y-0.5">
          {/* Line 1: Name */}
          <div className="text-[12px] font-semibold text-foreground truncate leading-tight">
            {worktree.displayName}
          </div>

          {/* Line 2: Repo badge + branch + primary badge */}
          <div className="flex items-center gap-1 min-w-0">
            {repo && (
              <Badge
                variant="dot"
                className="h-[18px] px-1.5 text-[10px] font-semibold font-mono rounded-[3px] shrink-0"
              >
                <RepoDotLabel
                  name={repo.displayName}
                  color={repo.badgeColor}
                  className="max-w-[9rem]"
                  dotClassName="size-1.5"
                />
              </Badge>
            )}
            <span className="text-[11px] text-muted-foreground truncate font-mono">{branch}</span>
            {isPrimaryBranch(worktree.branch) && (
              <Badge variant="outline" className="h-4 px-1 text-[9px] rounded-sm shrink-0">
                main
              </Badge>
            )}
          </div>

          {/* Line 3: PR */}
          {pr && (
            <HoverCard>
              <HoverCardTrigger
                delay={300}
                render={
                  <div className="flex items-center justify-between gap-2 min-w-0 cursor-default">
                    <div className="flex items-center gap-1 min-w-0">
                      <span className="text-[10px] text-muted-foreground shrink-0">PR</span>
                      <span className="text-[10px] text-foreground/80 truncate">{pr.title}</span>
                    </div>
                    <Badge
                      variant="secondary"
                      className={cn(
                        'h-3.5 px-1 text-[8px] rounded-sm shrink-0',
                        pr.state === 'merged' && 'text-purple-400',
                        pr.state === 'open' && 'text-emerald-400',
                        pr.state === 'closed' && 'text-neutral-400',
                        pr.state === 'draft' && 'text-neutral-500'
                      )}
                    >
                      {prStateLabel(pr.state)}
                    </Badge>
                  </div>
                }
              />
              <HoverCardContent side="right" align="start" className="w-72 p-3 text-xs space-y-1.5">
                <div className="font-semibold text-[13px]">
                  #{pr.number} {pr.title}
                </div>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <span>State: {prStateLabel(pr.state)}</span>
                  {pr.checksStatus !== 'neutral' && (
                    <span>Checks: {checksLabel(pr.checksStatus)}</span>
                  )}
                </div>
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  View on GitHub
                </a>
              </HoverCardContent>
            </HoverCard>
          )}

          {/* Line 4: Issue */}
          {issue && (
            <HoverCard>
              <HoverCardTrigger
                delay={300}
                render={
                  <div className="flex items-center justify-between gap-2 min-w-0 cursor-default">
                    <div className="flex items-center gap-1 min-w-0">
                      <span className="text-[10px] text-muted-foreground shrink-0">Issue</span>
                      <span className="text-[10px] text-foreground/80 truncate">{issue.title}</span>
                    </div>
                    <Badge
                      variant="secondary"
                      className={cn(
                        'h-3.5 px-1 text-[8px] rounded-sm shrink-0',
                        issue.state === 'open' ? 'text-emerald-400' : 'text-neutral-400'
                      )}
                    >
                      {issue.state === 'open' ? 'Open' : 'Closed'}
                    </Badge>
                  </div>
                }
              />
              <HoverCardContent side="right" align="start" className="w-72 p-3 text-xs space-y-1.5">
                <div className="font-semibold text-[13px]">
                  #{issue.number} {issue.title}
                </div>
                <div className="text-muted-foreground">
                  State: {issue.state === 'open' ? 'Open' : 'Closed'}
                </div>
                {issue.labels.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {issue.labels.map((l) => (
                      <Badge key={l} variant="outline" className="h-4 px-1.5 text-[9px]">
                        {l}
                      </Badge>
                    ))}
                  </div>
                )}
                <a
                  href={issue.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  View on GitHub
                </a>
              </HoverCardContent>
            </HoverCard>
          )}

          {/* Line 5: Comment */}
          {worktree.comment && (
            <HoverCard>
              <HoverCardTrigger
                delay={300}
                render={
                  <div className="text-[10px] text-muted-foreground truncate cursor-default italic">
                    {worktree.comment}
                  </div>
                }
              />
              <HoverCardContent side="right" align="start" className="w-64 p-3 text-xs">
                <p className="whitespace-pre-wrap">{worktree.comment}</p>
              </HoverCardContent>
            </HoverCard>
          )}
        </div>
      </div>
    </WorktreeContextMenu>
  )
})

export default WorktreeCard
