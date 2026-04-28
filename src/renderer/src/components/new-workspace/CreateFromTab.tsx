/* eslint-disable max-lines -- Why: this tab co-locates GitHub PR/issue/branch
and Linear sub-tabs + their fetch/resolve/launch plumbing so the "Create from…"
entry point lives in one file. Splitting would scatter debounce/caching logic
that only these sub-tabs use. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  CircleDot,
  CornerDownLeft,
  GitBranch,
  GitPullRequest,
  LoaderCircle,
  Search
} from 'lucide-react'
import { Input } from '@/components/ui/input'
import RepoCombobox from '@/components/repo/RepoCombobox'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { normalizeGitHubLinkQuery } from '@/lib/github-links'
import type { RepoSlug } from '@/lib/github-links'
import { launchWorkItemDirect, launchFromBranch } from '@/lib/launch-work-item-direct'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type { GitHubWorkItem, LinearIssue } from '../../../../shared/types'

export type CreateFromSubTab = 'prs' | 'issues' | 'branches' | 'linear'

type CreateFromTabProps = {
  /** Invoked after a successful workspace launch so the parent can close the
   *  dialog. */
  onLaunched: () => void
  /** Called when any code path needs to fall back to the Quick-tab composer
   *  (setup policy = 'ask', or the launch failed mid-flight). The parent is
   *  responsible for switching tabs and prefilling whatever context is
   *  available (linked work item, base branch, etc.). */
  onFallbackToQuick: (data: {
    initialRepoId?: string
    linkedWorkItem?: {
      type: 'issue' | 'pr'
      number: number
      title: string
      url: string
    } | null
    prefilledName?: string
    initialBaseBranch?: string
  }) => void
  /** Whether this tab is currently visible. Used by effects that should only
   *  run while the user can actually see the results (fetching, autoFocus). */
  active?: boolean
}

const SUB_TABS: {
  id: CreateFromSubTab
  label: string
  Icon: React.ComponentType<{ className?: string }>
}[] = [
  { id: 'prs', label: 'Pull requests', Icon: GitPullRequest },
  { id: 'issues', label: 'Issues', Icon: CircleDot },
  { id: 'branches', label: 'Branches', Icon: GitBranch },
  {
    id: 'linear',
    label: 'Linear',
    Icon: ({ className }: { className?: string }) => (
      <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
        <path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
      </svg>
    )
  }
]

const PR_LIST_LIMIT = 36
const ISSUE_LIST_LIMIT = 36
const LINEAR_LIST_LIMIT = 36
const SEARCH_DEBOUNCE_MS = 200

export default function CreateFromTab({
  onLaunched,
  onFallbackToQuick,
  active = true
}: CreateFromTabProps): React.JSX.Element {
  const {
    activeRepoId,
    repos,
    linearStatus,
    listLinearIssues,
    searchLinearIssues,
    rememberedSubTab,
    setRememberedSubTab
  } = useAppStore(
    useShallow((s) => ({
      activeRepoId: s.activeRepoId,
      repos: s.repos,
      linearStatus: s.linearStatus,
      listLinearIssues: s.listLinearIssues,
      searchLinearIssues: s.searchLinearIssues,
      rememberedSubTab: s.createFromSubTab,
      setRememberedSubTab: s.setCreateFromSubTab
    }))
  )

  const eligibleRepos = useMemo(() => repos.filter((r) => isGitRepoKind(r)), [repos])

  // Why: seed from the remembered sub-tab so users returning to Create-from
  // land on whichever source they worked from last (GitHub Issues, Linear,
  // …). A writer-through setter keeps the store in sync whenever the user
  // switches, which persists across composer closes within the same session.
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const [subTab, setSubTabLocal] = useState<CreateFromSubTab>(rememberedSubTab)
  const setSubTab = useCallback(
    (next: CreateFromSubTab) => {
      setSubTabLocal(next)
      setRememberedSubTab(next)
    },
    [setRememberedSubTab]
  )
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [selectedRepoId, setSelectedRepoId] = useState<string>(() => {
    if (activeRepoId && eligibleRepos.some((r) => r.id === activeRepoId)) {
      return activeRepoId
    }
    return eligibleRepos[0]?.id ?? ''
  })

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [query])

  // Why: auto-focus the search input when this tab becomes visible — but
  // only when it's actually visible. Without the `active` guard, the
  // AnimatedTabPanels wrapper (which keeps both panels mounted for
  // state-preservation and height measurement) would let the search field
  // steal focus from the Quick tab's repo combobox on modal open.
  useEffect(() => {
    if (!active) {
      return
    }
    const el = searchInputRef.current
    if (!el) {
      return
    }
    // Defer one frame so Radix's FocusScope on the Dialog doesn't
    // immediately reclaim focus to its first tabbable.
    const raf = requestAnimationFrame(() => el.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(raf)
  }, [active])

  const selectedRepo = useMemo(
    () => eligibleRepos.find((r) => r.id === selectedRepoId) ?? null,
    [eligibleRepos, selectedRepoId]
  )
  const isRemoteRepo = Boolean(selectedRepo?.connectionId)

  // Why: resolve the repo slug once so normalizeGitHubLinkQuery can detect
  // pasted URLs that target a different repo than the selected one — same
  // treatment StartFromPicker applies, so the "paste a URL" flow feels
  // identical between the two surfaces.
  const [repoSlug, setRepoSlug] = useState<RepoSlug | null>(null)
  useEffect(() => {
    if (!selectedRepo?.path) {
      setRepoSlug(null)
      return
    }
    let stale = false
    void window.api.gh
      .repoSlug({ repoPath: selectedRepo.path })
      .then((slug) => {
        if (!stale) {
          setRepoSlug(slug)
        }
      })
      .catch(() => {
        if (!stale) {
          setRepoSlug(null)
        }
      })
    return () => {
      stale = true
    }
  }, [selectedRepo?.path])

  const normalizedGhQuery = useMemo(
    () => normalizeGitHubLinkQuery(debouncedQuery, repoSlug),
    [debouncedQuery, repoSlug]
  )

  // ---------------------------------------------------------------------
  // GitHub PRs
  // ---------------------------------------------------------------------
  const [prItems, setPrItems] = useState<GitHubWorkItem[]>([])
  const [prLoading, setPrLoading] = useState(false)
  const [prError, setPrError] = useState<string | null>(null)
  const [directPr, setDirectPr] = useState<GitHubWorkItem | null>(null)

  useEffect(() => {
    if (subTab !== 'prs' || !selectedRepo?.path || isRemoteRepo) {
      return
    }
    if (normalizedGhQuery.directNumber !== null) {
      return // handled by direct-lookup effect below
    }
    const trimmed = debouncedQuery.trim()
    const q =
      trimmed && !normalizedGhQuery.repoMismatch
        ? `is:pr is:open ${normalizedGhQuery.query}`
        : 'is:pr is:open'

    let stale = false
    setPrLoading(true)
    setPrError(null)
    void window.api.gh
      .listWorkItems({ repoPath: selectedRepo.path, limit: PR_LIST_LIMIT, query: q })
      .then((items) => {
        if (stale) {
          return
        }
        setPrItems(
          items
            .filter((i) => i.type === 'pr')
            .map((i) => ({ ...i, repoId: selectedRepo.id })) as unknown as GitHubWorkItem[]
        )
        setPrLoading(false)
      })
      .catch((err) => {
        if (stale) {
          return
        }
        setPrError(err instanceof Error ? err.message : 'Failed to load PRs.')
        setPrLoading(false)
      })
    return () => {
      stale = true
    }
  }, [
    subTab,
    selectedRepo?.id,
    selectedRepo?.path,
    isRemoteRepo,
    debouncedQuery,
    normalizedGhQuery.query,
    normalizedGhQuery.repoMismatch,
    normalizedGhQuery.directNumber
  ])

  // ---------------------------------------------------------------------
  // GitHub Issues
  // ---------------------------------------------------------------------
  const [issueItems, setIssueItems] = useState<GitHubWorkItem[]>([])
  const [issueLoading, setIssueLoading] = useState(false)
  const [issueError, setIssueError] = useState<string | null>(null)

  useEffect(() => {
    if (subTab !== 'issues' || !selectedRepo?.path || isRemoteRepo) {
      return
    }
    if (normalizedGhQuery.directNumber !== null) {
      return
    }
    const trimmed = debouncedQuery.trim()
    const q =
      trimmed && !normalizedGhQuery.repoMismatch
        ? `is:issue is:open ${normalizedGhQuery.query}`
        : 'is:issue is:open'

    let stale = false
    setIssueLoading(true)
    setIssueError(null)
    void window.api.gh
      .listWorkItems({ repoPath: selectedRepo.path, limit: ISSUE_LIST_LIMIT, query: q })
      .then((items) => {
        if (stale) {
          return
        }
        setIssueItems(
          items
            .filter((i) => i.type === 'issue')
            .map((i) => ({ ...i, repoId: selectedRepo.id })) as unknown as GitHubWorkItem[]
        )
        setIssueLoading(false)
      })
      .catch((err) => {
        if (stale) {
          return
        }
        setIssueError(err instanceof Error ? err.message : 'Failed to load issues.')
        setIssueLoading(false)
      })
    return () => {
      stale = true
    }
  }, [
    subTab,
    selectedRepo?.id,
    selectedRepo?.path,
    isRemoteRepo,
    debouncedQuery,
    normalizedGhQuery.query,
    normalizedGhQuery.repoMismatch,
    normalizedGhQuery.directNumber
  ])

  // ---------------------------------------------------------------------
  // Direct `#N` / URL lookup across PR + Issue tabs
  // ---------------------------------------------------------------------
  const [directLoading, setDirectLoading] = useState(false)
  useEffect(() => {
    if ((subTab !== 'prs' && subTab !== 'issues') || !selectedRepo?.path || isRemoteRepo) {
      setDirectPr(null)
      return
    }
    const directNumber = normalizedGhQuery.directNumber
    if (directNumber === null) {
      setDirectPr(null)
      return
    }
    let stale = false
    setDirectLoading(true)
    void window.api.gh
      .workItem({ repoPath: selectedRepo.path, number: directNumber })
      .then((item) => {
        if (stale) {
          return
        }
        const gh = item as GitHubWorkItem | null
        if (!gh) {
          setDirectPr(null)
        } else {
          const wantedType = subTab === 'prs' ? 'pr' : 'issue'
          setDirectPr(
            gh.type === wantedType
              ? ({ ...gh, repoId: selectedRepo.id } as unknown as GitHubWorkItem)
              : null
          )
        }
      })
      .catch(() => {
        if (!stale) {
          setDirectPr(null)
        }
      })
      .finally(() => {
        if (!stale) {
          setDirectLoading(false)
        }
      })
    return () => {
      stale = true
    }
  }, [subTab, selectedRepo?.id, selectedRepo?.path, isRemoteRepo, normalizedGhQuery.directNumber])

  // ---------------------------------------------------------------------
  // Branches
  // ---------------------------------------------------------------------
  const [branches, setBranches] = useState<string[]>([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  useEffect(() => {
    if (subTab !== 'branches' || !selectedRepo) {
      return
    }
    const trimmed = debouncedQuery.trim()
    let stale = false
    setBranchesLoading(true)
    void window.api.repos
      .searchBaseRefs({ repoId: selectedRepo.id, query: trimmed, limit: 30 })
      .then((results) => {
        if (!stale) {
          setBranches(results)
        }
      })
      .catch(() => {
        if (!stale) {
          setBranches([])
        }
      })
      .finally(() => {
        if (!stale) {
          setBranchesLoading(false)
        }
      })
    return () => {
      stale = true
    }
  }, [subTab, selectedRepo, debouncedQuery])

  // ---------------------------------------------------------------------
  // Linear
  // ---------------------------------------------------------------------
  const [linearIssues, setLinearIssues] = useState<LinearIssue[]>([])
  const [linearLoading, setLinearLoading] = useState(false)
  const [linearError, setLinearError] = useState<string | null>(null)
  useEffect(() => {
    if (subTab !== 'linear' || !linearStatus.connected) {
      return
    }
    let stale = false
    setLinearLoading(true)
    setLinearError(null)
    const trimmed = debouncedQuery.trim()
    const request = trimmed
      ? searchLinearIssues(trimmed, LINEAR_LIST_LIMIT)
      : listLinearIssues('assigned', LINEAR_LIST_LIMIT)
    void request
      .then((items) => {
        if (!stale) {
          setLinearIssues(items)
          setLinearLoading(false)
        }
      })
      .catch((err) => {
        if (!stale) {
          setLinearError(err instanceof Error ? err.message : 'Failed to load Linear issues.')
          setLinearLoading(false)
        }
      })
    return () => {
      stale = true
    }
    // Why: list/search methods are stable store selectors; depending on them
    // would re-run the effect on unrelated store updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subTab, linearStatus.connected, debouncedQuery])

  // ---------------------------------------------------------------------
  // Selection handlers — each defers to launchWorkItemDirect / launchFromBranch
  // and falls back to the Quick tab on policy=ask.
  // ---------------------------------------------------------------------
  // Why: a single in-flight token guards against double-clicks and tab
  // switches racing with slow network calls (PR base-ref resolution can take
  // multiple seconds on cold caches).
  const inflightRef = useRef(0)
  const [launching, setLaunching] = useState(false)

  const handlePrSelect = useCallback(
    async (item: GitHubWorkItem) => {
      if (!selectedRepo || item.type !== 'pr') {
        return
      }
      const token = ++inflightRef.current
      setLaunching(true)
      try {
        const result = await window.api.worktrees.resolvePrBase({
          repoId: selectedRepo.id,
          prNumber: item.number,
          ...(item.branchName ? { headRefName: item.branchName } : {}),
          ...(item.isCrossRepository !== undefined
            ? { isCrossRepository: item.isCrossRepository }
            : {})
        })
        if (token !== inflightRef.current) {
          return
        }
        if ('error' in result) {
          // Why: failed head resolution still gives the user something to do —
          // hand off to Quick with the linked PR so they can pick a different
          // base branch manually instead of being stuck on this tab.
          onFallbackToQuick({
            initialRepoId: selectedRepo.id,
            linkedWorkItem: {
              type: 'pr',
              number: item.number,
              title: item.title,
              url: item.url
            },
            prefilledName: item.title
          })
          return
        }
        await launchWorkItemDirect({
          item: {
            title: item.title,
            url: item.url,
            type: 'pr',
            number: item.number
          },
          repoId: selectedRepo.id,
          baseBranch: result.baseBranch,
          openModalFallback: () =>
            onFallbackToQuick({
              initialRepoId: selectedRepo.id,
              linkedWorkItem: {
                type: 'pr',
                number: item.number,
                title: item.title,
                url: item.url
              },
              prefilledName: item.title,
              initialBaseBranch: result.baseBranch
            })
        })
        if (token === inflightRef.current) {
          onLaunched()
        }
      } finally {
        if (token === inflightRef.current) {
          setLaunching(false)
        }
      }
    },
    [onFallbackToQuick, onLaunched, selectedRepo]
  )

  const handleIssueSelect = useCallback(
    async (item: GitHubWorkItem) => {
      if (!selectedRepo || item.type !== 'issue') {
        return
      }
      const token = ++inflightRef.current
      setLaunching(true)
      try {
        await launchWorkItemDirect({
          item: {
            title: item.title,
            url: item.url,
            type: 'issue',
            number: item.number
          },
          repoId: selectedRepo.id,
          openModalFallback: () =>
            onFallbackToQuick({
              initialRepoId: selectedRepo.id,
              linkedWorkItem: {
                type: 'issue',
                number: item.number,
                title: item.title,
                url: item.url
              },
              prefilledName: item.title
            })
        })
        if (token === inflightRef.current) {
          onLaunched()
        }
      } finally {
        if (token === inflightRef.current) {
          setLaunching(false)
        }
      }
    },
    [onFallbackToQuick, onLaunched, selectedRepo]
  )

  const handleBranchSelect = useCallback(
    async (refName: string) => {
      if (!selectedRepo) {
        return
      }
      const token = ++inflightRef.current
      setLaunching(true)
      try {
        await launchFromBranch({
          repoId: selectedRepo.id,
          baseBranch: refName,
          openModalFallback: () => onFallbackToQuick({ initialRepoId: selectedRepo.id })
        })
        if (token === inflightRef.current) {
          onLaunched()
        }
      } finally {
        if (token === inflightRef.current) {
          setLaunching(false)
        }
      }
    },
    [onFallbackToQuick, onLaunched, selectedRepo]
  )

  const handleLinearSelect = useCallback(
    async (issue: LinearIssue) => {
      // Why: Linear issues aren't scoped to a git repo, so pick the active
      // repo (or the first eligible) as a target for the worktree. Users can
      // still override via the Quick tab fallback if setup policy is `ask`.
      const repoForLaunch =
        eligibleRepos.find((r) => r.id === selectedRepoId) ?? eligibleRepos[0] ?? null
      if (!repoForLaunch) {
        onFallbackToQuick({})
        return
      }
      const token = ++inflightRef.current
      setLaunching(true)
      try {
        const parts = [
          `[${issue.identifier}] ${issue.title}`,
          `Status: ${issue.state.name} · Team: ${issue.team.name}`,
          issue.assignee ? `Assignee: ${issue.assignee.displayName}` : null,
          issue.labels.length > 0 ? `Labels: ${issue.labels.join(', ')}` : null,
          `URL: ${issue.url}`,
          issue.description ? `\n${issue.description}` : null
        ]
        const pasteContent = parts.filter(Boolean).join('\n')
        await launchWorkItemDirect({
          item: {
            title: issue.title,
            url: issue.url,
            type: 'issue',
            number: null,
            pasteContent
          },
          repoId: repoForLaunch.id,
          openModalFallback: () =>
            onFallbackToQuick({
              initialRepoId: repoForLaunch.id,
              linkedWorkItem: {
                type: 'issue',
                // Why: Linear identifiers are strings (e.g. "ENG-123") — use 0
                // as a placeholder since the URL is what the agent acts on.
                number: 0,
                title: issue.title,
                url: issue.url
              },
              prefilledName: issue.title
            })
        })
        if (token === inflightRef.current) {
          onLaunched()
        }
      } finally {
        if (token === inflightRef.current) {
          setLaunching(false)
        }
      }
    },
    [eligibleRepos, onFallbackToQuick, onLaunched, selectedRepoId]
  )

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------
  const visiblePrItems = useMemo(() => {
    if (normalizedGhQuery.directNumber !== null) {
      return directPr && directPr.type === 'pr' ? [directPr] : []
    }
    return prItems
  }, [directPr, normalizedGhQuery.directNumber, prItems])
  const visibleIssueItems = useMemo(() => {
    if (normalizedGhQuery.directNumber !== null) {
      return directPr && directPr.type === 'issue' ? [directPr] : []
    }
    return issueItems
  }, [directPr, normalizedGhQuery.directNumber, issueItems])

  const placeholderBySubTab: Record<CreateFromSubTab, string> = {
    prs: 'Search PRs, paste #N or URL…',
    issues: 'Search issues, paste #N or URL…',
    branches: 'Search branches…',
    linear: 'Search Linear issues…'
  }

  const showGhRepoPicker = subTab !== 'linear'

  return (
    <div className="flex flex-col gap-3">
      {/* Why: give the Repository selector a stable row above the tabs so
          switching to Linear (which hides the picker) doesn't rearrange the
          sub-tab row, and the sub-tabs get the full width for themselves.
          Matches the field-label style used on the Quick tab so the two
          surfaces feel like the same form dialect.

          The grid-template-rows 0fr↔1fr trick animates the picker's
          collapse/expand smoothly when the user moves between Linear (no
          repo picker) and GH sub-tabs. We keep the DOM mounted across the
          transition so focus/state inside the combobox survives, and clip
          the overflow so the shrinking row never peeks past the borders. */}
      <div
        className={cn(
          'grid transition-[grid-template-rows,opacity,margin] duration-200 ease-out',
          showGhRepoPicker ? 'grid-rows-[1fr] opacity-100' : '-mt-3 grid-rows-[0fr] opacity-0'
        )}
        aria-hidden={!showGhRepoPicker}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Repository</label>
            <RepoCombobox
              repos={eligibleRepos}
              value={selectedRepoId}
              onValueChange={setSelectedRepoId}
              placeholder="Repository"
              triggerClassName="h-8 w-full border-input text-xs"
              showStandaloneAddButton={false}
            />
          </div>
        </div>
      </div>

      <Tabs
        value={subTab}
        onValueChange={(v) => setSubTab(v as CreateFromSubTab)}
        className="gap-0"
      >
        <TabsList
          variant="line"
          className="h-8 w-full justify-start gap-5 border-b border-border/40 px-0"
        >
          {SUB_TABS.map(({ id, label, Icon }) => (
            <TabsTrigger key={id} value={id} className="flex-none gap-1.5 px-0 text-xs">
              <Icon className="size-3.5" />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="pt-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={placeholderBySubTab[subTab]}
              className="h-9 pl-8 text-sm"
            />
          </div>
        </div>

        <TabsContent value="prs" className="mt-2">
          <ResultList>
            {isRemoteRepo ? (
              <EmptyMessage>
                PR start points aren&apos;t supported for remote repos yet.
              </EmptyMessage>
            ) : normalizedGhQuery.repoMismatch && normalizedGhQuery.directNumber === null ? (
              <EmptyMessage>
                URL targets {normalizedGhQuery.repoMismatch}, not the selected repo.
              </EmptyMessage>
            ) : prError ? (
              <EmptyMessage>
                {prError.includes('gh') ? 'gh not available — Branches tab still works' : prError}
              </EmptyMessage>
            ) : (prLoading || directLoading) && visiblePrItems.length === 0 ? (
              <LoadingRows />
            ) : visiblePrItems.length === 0 ? (
              <EmptyMessage>
                {normalizedGhQuery.directNumber !== null
                  ? `No PR #${normalizedGhQuery.directNumber}`
                  : 'No open PRs'}
              </EmptyMessage>
            ) : (
              visiblePrItems.map((item) => (
                <PrRow
                  key={`pr-${item.number}`}
                  item={item}
                  disabled={launching}
                  onSelect={() => void handlePrSelect(item)}
                />
              ))
            )}
          </ResultList>
        </TabsContent>

        <TabsContent value="issues" className="mt-2">
          <ResultList>
            {isRemoteRepo ? (
              <EmptyMessage>
                Issue start points aren&apos;t supported for remote repos yet.
              </EmptyMessage>
            ) : normalizedGhQuery.repoMismatch && normalizedGhQuery.directNumber === null ? (
              <EmptyMessage>
                URL targets {normalizedGhQuery.repoMismatch}, not the selected repo.
              </EmptyMessage>
            ) : issueError ? (
              <EmptyMessage>
                {issueError.includes('gh')
                  ? 'gh not available — Branches tab still works'
                  : issueError}
              </EmptyMessage>
            ) : (issueLoading || directLoading) && visibleIssueItems.length === 0 ? (
              <LoadingRows />
            ) : visibleIssueItems.length === 0 ? (
              <EmptyMessage>
                {normalizedGhQuery.directNumber !== null
                  ? `No issue #${normalizedGhQuery.directNumber}`
                  : 'No open issues'}
              </EmptyMessage>
            ) : (
              visibleIssueItems.map((item) => (
                <IssueRow
                  key={`issue-${item.number}`}
                  item={item}
                  disabled={launching}
                  onSelect={() => void handleIssueSelect(item)}
                />
              ))
            )}
          </ResultList>
        </TabsContent>

        <TabsContent value="branches" className="mt-2">
          <ResultList>
            {branchesLoading && branches.length === 0 ? (
              <LoadingRows />
            ) : branches.length === 0 ? (
              <EmptyMessage>
                {query.trim() ? 'No branches match' : 'No branches found'}
              </EmptyMessage>
            ) : (
              branches.map((refName) => (
                <BranchRow
                  key={refName}
                  refName={refName}
                  disabled={launching}
                  onSelect={() => void handleBranchSelect(refName)}
                />
              ))
            )}
          </ResultList>
        </TabsContent>

        <TabsContent value="linear" className="mt-2">
          <ResultList>
            {!linearStatus.connected ? (
              <EmptyMessage>
                Connect Linear from Settings → Integrations to create workspaces from Linear issues.
              </EmptyMessage>
            ) : linearError ? (
              <EmptyMessage>{linearError}</EmptyMessage>
            ) : linearLoading && linearIssues.length === 0 ? (
              <LoadingRows />
            ) : linearIssues.length === 0 ? (
              <EmptyMessage>
                {query.trim() ? 'No Linear issues match' : 'No Linear issues assigned to you'}
              </EmptyMessage>
            ) : (
              linearIssues.map((issue) => (
                <LinearRow
                  key={issue.id}
                  issue={issue}
                  disabled={launching}
                  onSelect={() => void handleLinearSelect(issue)}
                />
              ))
            )}
          </ResultList>
        </TabsContent>
      </Tabs>

      {launching ? (
        <div className="flex items-center gap-2 px-1 pt-1 text-[11px] text-muted-foreground">
          <LoaderCircle className="size-3 animate-spin" />
          Creating workspace…
        </div>
      ) : null}
    </div>
  )
}

function ResultList({ children }: { children: React.ReactNode }): React.JSX.Element {
  // Why: two nested containers so the scrollbar stays inside the rounded
  // border. The outer clips with overflow-hidden and owns the rounded
  // corners; the inner owns the scroll. If overflow-auto sits on the
  // rounded element directly, Chromium paints the native scrollbar flush
  // against the border box, and the track bleeds past the rounded corner —
  // which is exactly the "scrollbar floating outside the modal" bug.
  //
  // The inner flex column lets empty-state / loading content vertically
  // center when it's the only child; populated lists still render from the
  // top because their rows exceed the fixed height and the scroller
  // takes over.
  return (
    <div className="h-[320px] overflow-hidden rounded-md border border-border/50">
      <div className="flex h-full min-h-full flex-col overflow-y-auto p-1">{children}</div>
    </div>
  )
}

function LoadingRows(): React.JSX.Element {
  return (
    <div className="space-y-1 p-1">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-8 animate-pulse rounded bg-muted/40" />
      ))}
    </div>
  )
}

function EmptyMessage({ children }: { children: React.ReactNode }): React.JSX.Element {
  // Why: flex-1 + centered content means the message floats in the middle
  // of the 320px result box regardless of how tall the message itself is,
  // which feels intentional rather than the old "message stuck near the top"
  // look that accompanied `py-10`.
  return (
    <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
      {children}
    </div>
  )
}

function RowShell({
  onSelect,
  disabled,
  children,
  title
}: {
  onSelect: () => void
  disabled: boolean
  children: React.ReactNode
  title?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      title={title}
      className={cn(
        'group flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition hover:bg-muted/60',
        disabled && 'cursor-not-allowed opacity-60 hover:bg-transparent'
      )}
    >
      {children}
      <CornerDownLeft className="ml-auto size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  )
}

function PrRow({
  item,
  disabled,
  onSelect
}: {
  item: GitHubWorkItem
  disabled: boolean
  onSelect: () => void
}): React.JSX.Element {
  const isFork = item.isCrossRepository === true
  return (
    <RowShell
      onSelect={onSelect}
      disabled={disabled}
      title={isFork ? 'Fork PR — will branch from a snapshot of the PR head' : undefined}
    >
      <GitPullRequest className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="text-muted-foreground">#{item.number}</span>
          <span className="truncate">{item.title}</span>
        </span>
        {item.branchName ? (
          <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">
            {item.branchName}
            {isFork ? ' · fork' : ''}
          </span>
        ) : null}
      </span>
    </RowShell>
  )
}

function IssueRow({
  item,
  disabled,
  onSelect
}: {
  item: GitHubWorkItem
  disabled: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <RowShell onSelect={onSelect} disabled={disabled}>
      <CircleDot className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="text-muted-foreground">#{item.number}</span>
          <span className="truncate">{item.title}</span>
        </span>
        {item.author ? (
          <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
            {item.author}
          </span>
        ) : null}
      </span>
    </RowShell>
  )
}

function BranchRow({
  refName,
  disabled,
  onSelect
}: {
  refName: string
  disabled: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <RowShell onSelect={onSelect} disabled={disabled}>
      <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate font-mono">{refName}</span>
    </RowShell>
  )
}

function LinearRow({
  issue,
  disabled,
  onSelect
}: {
  issue: LinearIssue
  disabled: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <RowShell onSelect={onSelect} disabled={disabled}>
      <span className="font-mono text-[10px] text-muted-foreground shrink-0">
        {issue.identifier}
      </span>
      <span className="min-w-0 flex-1">
        <span className="truncate">{issue.title}</span>
        <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
          {issue.state.name}
          {issue.team.name ? ` · ${issue.team.name}` : ''}
        </span>
      </span>
    </RowShell>
  )
}
