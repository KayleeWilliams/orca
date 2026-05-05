/* eslint-disable max-lines -- Why: consolidating memory + sessions into one
   surface deliberately co-locates the sparkline, worktree tree, session list,
   and daemon-action footer so the popover body and badge stay consistent.
   Splitting across files would scatter render-state that only exists to
   serve this one status-bar segment. See docs/consolidated-resource-usage. */
import React, { memo, useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  LoaderCircle,
  MemoryStick,
  Moon,
  RotateCw,
  Terminal,
  Trash2,
  X
} from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '../../store'
import { useWorktreeMap } from '../../store/selectors'
import { runWorktreeDelete } from '../sidebar/delete-worktree-flow'
import { runSleepWorktree } from '../sidebar/sleep-worktree-flow'
import { useDaemonActions, DaemonActionDialog } from '../shared/useDaemonActions'
import type {
  AppMemory,
  SessionMemory,
  TerminalTab,
  UsageValues,
  Worktree,
  WorktreeMemory
} from '../../../../shared/types'
import { ORPHAN_WORKTREE_ID } from '../../../../shared/constants'

const POLL_MS = 2_000
const SESSIONS_POLL_MS = 10_000

type SortOption = 'memory' | 'cpu' | 'name'
type TabKey = 'resources' | 'sessions'

const METRIC_COLUMNS_CLS = 'flex items-center shrink-0 tabular-nums'
const CPU_COLUMN_CLS = 'w-12 text-right'
const MEM_COLUMN_CLS = 'w-16 text-right'

type DaemonSession = { id: string; cwd: string; title: string }

// ─── Formatters ─────────────────────────────────────────────────────

function formatMemory(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatCpu(percent: number): string {
  return `${percent.toFixed(1)}%`
}

function formatPercent(value: number): string {
  return `${value.toFixed(0)}%`
}

function shortCwd(cwd: string): string {
  if (!cwd) {
    return 'unknown'
  }
  const separator = cwd.includes('\\') ? '\\' : '/'
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  return parts.length > 2 ? parts.slice(-2).join(separator) : cwd
}

function sessionLabel(session: DaemonSession, tabTitle?: string): string {
  if (session.cwd) {
    return shortCwd(session.cwd)
  }
  const sep = session.id.lastIndexOf('@@')
  if (sep !== -1) {
    const worktreeId = session.id.slice(0, sep)
    return shortCwd(worktreeId)
  }
  if (tabTitle) {
    return tabTitle
  }
  if (session.title) {
    return session.title
  }
  return 'unknown'
}

function parsePaneKey(paneKey: string | null): { tabId: string; paneRuntimeId: number } | null {
  if (!paneKey) {
    return null
  }
  const sepIdx = paneKey.indexOf(':')
  if (sepIdx <= 0) {
    return null
  }
  const paneRuntimeId = Number(paneKey.slice(sepIdx + 1))
  if (!Number.isFinite(paneRuntimeId)) {
    return null
  }
  return { tabId: paneKey.slice(0, sepIdx), paneRuntimeId }
}

function sessionRowLabel(
  session: SessionMemory,
  worktreeId: string,
  tabsByWorktree: Record<string, TerminalTab[]>,
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
): string {
  const parsed = parsePaneKey(session.paneKey)
  if (parsed) {
    const tabs = tabsByWorktree[worktreeId] ?? []
    const tabIndex = tabs.findIndex((t) => t.id === parsed.tabId)
    const tab = tabIndex >= 0 ? tabs[tabIndex] : undefined
    if (tab) {
      const custom = tab.customTitle?.trim()
      if (custom) {
        return custom
      }
      const runtime = runtimePaneTitlesByTabId[parsed.tabId]?.[parsed.paneRuntimeId]?.trim()
      if (runtime) {
        return runtime
      }
      return tab.defaultTitle?.trim() || tab.title?.trim() || `Terminal ${tabIndex + 1}`
    }
  }
  if (session.pid > 0) {
    return `pid ${session.pid}`
  }
  const fallback = session.sessionId?.slice(0, 8)
  return fallback ? `session ${fallback}` : '(unknown session)'
}

// ─── Grouping helpers ───────────────────────────────────────────────

type RepoGroup = {
  repoId: string
  repoName: string
  cpu: number
  memory: number
  worktrees: WorktreeMemory[]
}

function bucketByRepo(worktrees: WorktreeMemory[]): RepoGroup[] {
  const map = new Map<string, RepoGroup>()
  for (const wt of worktrees) {
    const key = wt.repoId || 'unknown'
    let group = map.get(key)
    if (!group) {
      group = {
        repoId: key,
        repoName: wt.repoName || 'Unknown Repo',
        cpu: 0,
        memory: 0,
        worktrees: []
      }
      map.set(key, group)
    }
    group.cpu += wt.cpu
    group.memory += wt.memory
    group.worktrees.push(wt)
  }
  return [...map.values()]
}

function sortWorktreesBy(
  list: WorktreeMemory[],
  sort: SortOption,
  labelFor: (wt: WorktreeMemory) => string
): WorktreeMemory[] {
  const copy = [...list]
  if (sort === 'memory') {
    copy.sort((a, b) => b.memory - a.memory)
  } else if (sort === 'cpu') {
    copy.sort((a, b) => b.cpu - a.cpu)
  } else {
    copy.sort((a, b) => labelFor(a).localeCompare(labelFor(b)))
  }
  return copy
}

function sortRepoGroupsBy(groups: RepoGroup[], sort: SortOption): RepoGroup[] {
  const copy = [...groups]
  if (sort === 'memory') {
    copy.sort((a, b) => b.memory - a.memory)
  } else if (sort === 'cpu') {
    copy.sort((a, b) => b.cpu - a.cpu)
  } else {
    copy.sort((a, b) => a.repoName.localeCompare(b.repoName))
  }
  return copy
}

// ─── Sparkline ──────────────────────────────────────────────────────

type SparklineProps = {
  samples: number[]
  width?: number
  height?: number
}

function SparklineImpl({ samples, width = 48, height = 14 }: SparklineProps): React.JSX.Element {
  const points = useMemo(() => {
    const safe = Array.isArray(samples) ? samples : []
    if (safe.length < 2) {
      const midY = (height / 2).toFixed(1)
      return `0,${midY} ${width},${midY}`
    }

    let min = safe[0]
    let max = safe[0]
    for (const v of safe) {
      if (v < min) {
        min = v
      }
      if (v > max) {
        max = v
      }
    }
    const range = max - min || 1
    const stepX = width / (safe.length - 1)

    const out: string[] = []
    for (let i = 0; i < safe.length; i++) {
      const x = (i * stepX).toFixed(1)
      const y = (height - ((safe[i] - min) / range) * height).toFixed(1)
      out.push(`${x},${y}`)
    }
    return out.join(' ')
  }, [samples, width, height])

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
      preserveAspectRatio="none"
    >
      <polyline
        points={points}
        fill="none"
        strokeWidth={1}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-muted-foreground/70"
      />
    </svg>
  )
}

const Sparkline = memo(SparklineImpl, (a, b) => {
  if (a.width !== b.width || a.height !== b.height) {
    return false
  }
  const sa = Array.isArray(a.samples) ? a.samples : []
  const sb = Array.isArray(b.samples) ? b.samples : []
  if (sa === sb) {
    return true
  }
  if (sa.length !== sb.length) {
    return false
  }
  for (let i = 0; i < sa.length; i++) {
    if (sa[i] !== sb[i]) {
      return false
    }
  }
  return true
})

// ─── Leaf UI: metric row ────────────────────────────────────────────

function MetricPair({
  cpu,
  memory,
  size = 'base'
}: {
  cpu: number
  memory: number
  size?: 'base' | 'small'
}): React.JSX.Element {
  const textCls = size === 'small' ? 'text-[11px]' : 'text-xs'
  return (
    <div className={cn(METRIC_COLUMNS_CLS, textCls, 'text-muted-foreground')}>
      <span className={CPU_COLUMN_CLS}>{formatCpu(cpu)}</span>
      <span className={MEM_COLUMN_CLS}>{formatMemory(memory)}</span>
    </div>
  )
}

function AppSubRow({ label, values }: { label: string; values: UsageValues }): React.JSX.Element {
  return (
    <div className="px-3 py-1.5 pl-6 flex items-center justify-between">
      <span className="text-[11px] text-muted-foreground truncate">{label}</span>
      <MetricPair cpu={values.cpu} memory={values.memory} size="small" />
    </div>
  )
}

function AppSection({
  app,
  isCollapsed,
  onToggle
}: {
  app: AppMemory
  isCollapsed: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <div className="border-t border-border/50">
      <div className="flex items-center">
        <button
          type="button"
          onClick={onToggle}
          className="pl-2 py-2 pr-0.5 transition-colors hover:bg-muted/50"
          aria-label={isCollapsed ? 'Expand Orca' : 'Collapse Orca'}
          aria-expanded={!isCollapsed}
        >
          {isCollapsed ? (
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          )}
        </button>
        <div className="flex-1 min-w-0 py-2 pr-3 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide truncate text-muted-foreground">
            Orca
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <Sparkline samples={app.history} />
            <MetricPair cpu={app.cpu} memory={app.memory} />
          </div>
        </div>
      </div>
      {!isCollapsed && (
        <div className="border-t border-border/30">
          <AppSubRow label="Main" values={app.main} />
          <AppSubRow label="Renderer" values={app.renderer} />
          {(app.other.cpu > 0 || app.other.memory > 0) && (
            <AppSubRow label="Other" values={app.other} />
          )}
        </div>
      )}
    </div>
  )
}

// ─── Worktree tree ──────────────────────────────────────────────────

function WorktreeRow({
  worktree,
  storeRecord,
  isCollapsed,
  onToggle,
  onNavigate,
  onSleep,
  onDelete,
  tabsByWorktree,
  runtimePaneTitlesByTabId
}: {
  worktree: WorktreeMemory
  storeRecord: Worktree | null
  isCollapsed: boolean
  onToggle: () => void
  onNavigate: () => void
  onSleep: () => void
  onDelete: () => void
  tabsByWorktree: Record<string, TerminalTab[]>
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
}): React.JSX.Element {
  const hasSessions = worktree.sessions.length > 0
  const showActions = worktree.worktreeId !== ORPHAN_WORKTREE_ID && storeRecord !== null
  const isMainWorktree = storeRecord?.isMainWorktree ?? false
  const rowLabel = storeRecord?.displayName?.trim() || worktree.worktreeName

  return (
    <div className="border-b border-border/20 last:border-b-0">
      <div className="group/wtrow flex items-center ml-2 transition-colors hover:bg-muted/60">
        {hasSessions ? (
          <button
            type="button"
            onClick={onToggle}
            className="pl-2 py-2 pr-0.5 shrink-0"
            aria-label={isCollapsed ? 'Expand workspace' : 'Collapse workspace'}
          >
            {isCollapsed ? (
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            )}
          </button>
        ) : (
          <span
            className="pl-2 py-2 pr-0.5 shrink-0 w-[calc(0.5rem+0.75rem+0.125rem)]"
            aria-hidden
          />
        )}
        <button
          type="button"
          onClick={onNavigate}
          aria-label={`Open workspace ${rowLabel}`}
          className="flex-1 min-w-0 py-2 pr-2 pl-1 text-left"
        >
          <span className="text-xs font-medium truncate block">{rowLabel}</span>
        </button>
        <div className="flex items-center gap-2 shrink-0 pr-3">
          <div className="relative">
            <span
              className={cn(
                'block transition-opacity',
                showActions &&
                  'group-hover/wtrow:opacity-0 group-hover/wtrow:pointer-events-none group-focus-within/wtrow:opacity-0 group-focus-within/wtrow:pointer-events-none'
              )}
              aria-hidden={showActions ? undefined : true}
            >
              <Sparkline samples={worktree.history} />
            </span>
            {showActions && (
              <div className="absolute inset-0 flex items-center justify-end gap-0.5 opacity-0 pointer-events-none transition-opacity group-hover/wtrow:opacity-100 group-hover/wtrow:pointer-events-auto group-focus-within/wtrow:opacity-100 group-focus-within/wtrow:pointer-events-auto">
                <Tooltip delayDuration={300}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={onSleep}
                      aria-label={`Sleep workspace ${rowLabel}`}
                      className="p-0.5 rounded text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                    >
                      <Moon className="size-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="top"
                    sideOffset={4}
                    className="z-[70] max-w-[200px] text-pretty"
                  >
                    Sleep — close all panels in this workspace to free memory.
                  </TooltipContent>
                </Tooltip>
                <Tooltip delayDuration={300}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={onDelete}
                      disabled={isMainWorktree}
                      aria-label={`Delete workspace ${rowLabel}`}
                      className={cn(
                        'p-0.5 rounded text-muted-foreground transition-colors',
                        isMainWorktree
                          ? 'opacity-40 cursor-not-allowed'
                          : 'hover:bg-destructive/10 hover:text-destructive'
                      )}
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="top"
                    sideOffset={4}
                    className="z-[70] max-w-[200px] text-pretty"
                  >
                    {isMainWorktree ? 'The main workspace cannot be deleted.' : 'Delete workspace.'}
                  </TooltipContent>
                </Tooltip>
              </div>
            )}
          </div>
          <MetricPair cpu={worktree.cpu} memory={worktree.memory} />
        </div>
      </div>

      {!isCollapsed &&
        worktree.sessions.map((session) => (
          <div
            key={`${session.sessionId}:${session.pid}`}
            className="px-3 py-1.5 pl-10 flex items-center justify-between"
          >
            <span className="text-[11px] text-muted-foreground truncate min-w-0 mr-2">
              {sessionRowLabel(
                session,
                worktree.worktreeId,
                tabsByWorktree,
                runtimePaneTitlesByTabId
              )}
            </span>
            <MetricPair cpu={session.cpu} memory={session.memory} size="small" />
          </div>
        ))}
    </div>
  )
}

function WorktreeSection({
  worktrees,
  sortOption,
  collapsedRepos,
  toggleRepo,
  collapsedWorktrees,
  toggleWorktree,
  navigateToWorktree,
  onSleep,
  onDelete
}: {
  worktrees: WorktreeMemory[]
  sortOption: SortOption
  collapsedRepos: Set<string>
  toggleRepo: (repoId: string) => void
  collapsedWorktrees: Set<string>
  toggleWorktree: (worktreeId: string) => void
  navigateToWorktree: (worktreeId: string) => void
  onSleep: (worktreeId: string) => void
  onDelete: (worktreeId: string) => void
}): React.JSX.Element {
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const runtimePaneTitlesByTabId = useAppStore((s) => s.runtimePaneTitlesByTabId)
  const worktreeById = useWorktreeMap()

  const labelFor = useCallback(
    (wt: WorktreeMemory): string =>
      worktreeById.get(wt.worktreeId)?.displayName?.trim() || wt.worktreeName,
    [worktreeById]
  )

  const repoGroups = useMemo(
    () =>
      sortRepoGroupsBy(bucketByRepo(worktrees), sortOption).map((group) => ({
        ...group,
        worktrees: sortWorktreesBy(group.worktrees, sortOption, labelFor)
      })),
    [worktrees, sortOption, labelFor]
  )

  const singleRepo = repoGroups.length === 1

  const renderWorktree = (wt: WorktreeMemory): React.JSX.Element => {
    const storeRecord = worktreeById.get(wt.worktreeId) ?? null
    return (
      <WorktreeRow
        key={wt.worktreeId}
        worktree={wt}
        storeRecord={storeRecord}
        isCollapsed={collapsedWorktrees.has(wt.worktreeId)}
        onToggle={() => toggleWorktree(wt.worktreeId)}
        onNavigate={() => navigateToWorktree(wt.worktreeId)}
        onSleep={() => onSleep(wt.worktreeId)}
        onDelete={() => onDelete(wt.worktreeId)}
        tabsByWorktree={tabsByWorktree}
        runtimePaneTitlesByTabId={runtimePaneTitlesByTabId}
      />
    )
  }

  if (singleRepo) {
    return <>{repoGroups[0].worktrees.map(renderWorktree)}</>
  }

  return (
    <>
      {repoGroups.map((group) => {
        const repoCollapsed = collapsedRepos.has(group.repoId)
        return (
          <div key={group.repoId} className="border-b border-border/50 last:border-b-0">
            <div className="flex items-center">
              <button
                type="button"
                onClick={() => toggleRepo(group.repoId)}
                className="pl-2 py-2 pr-0.5 transition-colors hover:bg-muted/50"
                aria-label={repoCollapsed ? 'Expand repo' : 'Collapse repo'}
              >
                {repoCollapsed ? (
                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-3 w-3 text-muted-foreground" />
                )}
              </button>
              <div className="flex-1 min-w-0 py-2 pr-3 flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wide truncate text-muted-foreground">
                  {group.repoName}
                </span>
                <MetricPair cpu={group.cpu} memory={group.memory} />
              </div>
            </div>

            {!repoCollapsed && (
              <div className="border-t border-border/30">{group.worktrees.map(renderWorktree)}</div>
            )}
          </div>
        )
      })}
    </>
  )
}

// ─── Sessions tab ───────────────────────────────────────────────────

function SessionsTabPanel({
  sessions,
  sessionsError,
  onCloseSegment,
  onSessionsChanged
}: {
  sessions: DaemonSession[]
  sessionsError: boolean
  onCloseSegment: () => void
  // Why: kill actions in this panel mutate daemon state but the parent owns
  // the polling timer + sessions list. Without an immediate refresh, killed
  // rows linger up to the 10s poll interval. Mirror the old SessionsSegment
  // behavior of refreshing right after the IPC settles.
  onSessionsChanged: () => void
}): React.JSX.Element {
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const ptyIdsByTabId = useAppStore((s) => s.ptyIdsByTabId)
  const runtimePaneTitlesByTabId = useAppStore((s) => s.runtimePaneTitlesByTabId)
  const workspaceSessionReady = useAppStore((s) => s.workspaceSessionReady)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const setActiveView = useAppStore((s) => s.setActiveView)

  const boundPtyIds = useMemo(
    () => new Set(Object.values(ptyIdsByTabId).flat().filter(Boolean)),
    [ptyIdsByTabId]
  )

  const ptyIdToTabId = useMemo(() => {
    const map = new Map<string, string>()
    for (const [tabId, ptyIds] of Object.entries(ptyIdsByTabId)) {
      for (const ptyId of ptyIds) {
        map.set(ptyId, tabId)
      }
    }
    return map
  }, [ptyIdsByTabId])

  const tabIdToWorktreeId = useMemo(() => {
    const map = new Map<string, string>()
    for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
      for (const tab of tabs) {
        map.set(tab.id, worktreeId)
      }
    }
    return map
  }, [tabsByWorktree])

  const ptyIdToTabTitle = useMemo(() => {
    const tabById = new Map<string, (typeof tabsByWorktree)[string][number]>()
    for (const tabs of Object.values(tabsByWorktree)) {
      for (const tab of tabs) {
        tabById.set(tab.id, tab)
      }
    }
    const map = new Map<string, string>()
    for (const [tabId, ptyIds] of Object.entries(ptyIdsByTabId)) {
      const tab = tabById.get(tabId)
      if (!tab) {
        continue
      }
      const runtimeTitles = runtimePaneTitlesByTabId[tabId]
      const liveTitle = runtimeTitles
        ? Object.values(runtimeTitles).find((t) => t?.trim())
        : undefined
      const title =
        tab.customTitle?.trim() || liveTitle?.trim() || tab.title || tab.defaultTitle?.trim()
      if (title) {
        for (const ptyId of ptyIds) {
          map.set(ptyId, title)
        }
      }
    }
    return map
  }, [ptyIdsByTabId, tabsByWorktree, runtimePaneTitlesByTabId])

  const orphanCount = workspaceSessionReady
    ? sessions.filter((s) => !boundPtyIds.has(s.id)).length
    : 0

  // Why: match the Settings page Manage Sessions pane — destructive
  // single-session kill goes through a confirm dialog rather than
  // firing on click. The dialog stays mounted on top of the popover.
  const [killConfirm, setKillConfirm] = useState<DaemonSession | null>(null)
  const [killing, setKilling] = useState(false)

  const runKillConfirmed = useCallback(async () => {
    if (!killConfirm) {
      return
    }
    setKilling(true)
    try {
      await window.api.pty.kill(killConfirm.id)
    } catch {
      /* already dead */
    } finally {
      setKilling(false)
      setKillConfirm(null)
      onSessionsChanged()
    }
  }, [killConfirm, onSessionsChanged])

  const handleKillOrphans = useCallback(async () => {
    if (!workspaceSessionReady) {
      return
    }
    const orphans = sessions.filter((s) => !boundPtyIds.has(s.id))
    await Promise.allSettled(orphans.map((s) => window.api.pty.kill(s.id)))
    onSessionsChanged()
  }, [sessions, boundPtyIds, workspaceSessionReady, onSessionsChanged])

  const handleNavigate = useCallback(
    (tabId: string) => {
      const worktreeId = tabIdToWorktreeId.get(tabId)
      if (worktreeId) {
        activateAndRevealWorktree(worktreeId)
      }
      setActiveView('terminal')
      setActiveTab(tabId)
      onCloseSegment()
    },
    [tabIdToWorktreeId, setActiveView, setActiveTab, onCloseSegment]
  )

  if (sessionsError && sessions.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-3 py-4 text-center text-[11px] text-muted-foreground">
        Terminal sessions unavailable.
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-2 pt-1.5 pb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground shrink-0">
        Terminal Sessions ({sessions.length})
      </div>
      {sessions.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground">
          No active sessions
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-sleek">
          {[...sessions]
            .sort((a, b) => {
              const aBound = workspaceSessionReady && boundPtyIds.has(a.id) ? 0 : 1
              const bBound = workspaceSessionReady && boundPtyIds.has(b.id) ? 0 : 1
              return aBound - bBound
            })
            .map((s) => {
              const tabId = ptyIdToTabId.get(s.id) ?? null
              const isBound = workspaceSessionReady && boundPtyIds.has(s.id)
              const title = ptyIdToTabTitle.get(s.id)
              return (
                <div
                  key={s.id}
                  className={cn(
                    'group/sessrow flex items-center gap-2 px-2 py-1.5 rounded',
                    tabId && 'cursor-pointer hover:bg-accent/60'
                  )}
                  onClick={tabId ? () => handleNavigate(tabId) : undefined}
                >
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${isBound ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] font-medium font-mono">
                      {sessionLabel(s, title)}
                    </div>
                  </div>
                  {/* Why: mirrors the Settings > Manage Sessions row — every
                      session gets a kill X. Bound sessions hide the X until
                      the row is hovered/focused so the list stays calm; the
                      kill flow opens a confirm Dialog before invoking IPC. */}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      setKillConfirm(s)
                    }}
                    className={cn(
                      'shrink-0 rounded p-0.5 text-muted-foreground transition-opacity hover:bg-destructive/10 hover:text-destructive',
                      isBound &&
                        'opacity-0 group-hover/sessrow:opacity-100 group-focus-within/sessrow:opacity-100 focus-visible:opacity-100'
                    )}
                    aria-label={`Kill session ${s.id}`}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              )
            })}
        </div>
      )}
      {orphanCount > 0 && (
        <div className="border-t border-border/50 px-2 py-2 shrink-0">
          <button
            type="button"
            onClick={() => void handleKillOrphans()}
            className="inline-flex w-full items-center justify-center rounded-md border border-border/70 px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent/60"
          >
            Kill {orphanCount} Orphan{orphanCount > 1 ? 's' : ''}
          </button>
        </div>
      )}

      <Dialog
        open={killConfirm !== null}
        onOpenChange={(open) => {
          if (open) {
            return
          }
          if (killing) {
            return
          }
          setKillConfirm(null)
        }}
      >
        <DialogContent
          className="max-w-md"
          showCloseButton={!killing}
          onPointerDownOutside={(e) => {
            if (killing) {
              e.preventDefault()
            }
          }}
          onEscapeKeyDown={(e) => {
            if (killing) {
              e.preventDefault()
            }
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-sm">Kill this session?</DialogTitle>
            <DialogDescription className="text-xs">
              Force-quits <span className="font-medium text-foreground">{killConfirm?.id}</span>.
              Any unsaved work in that pane is lost. This can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setKillConfirm(null)} disabled={killing}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void runKillConfirmed()}
              disabled={killing}
            >
              {killing ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {killing ? 'Killing…' : 'Kill session'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─── Top-level segment ──────────────────────────────────────────────

export function ResourceUsageStatusSegment({
  iconOnly
}: {
  compact?: boolean
  iconOnly: boolean
}): React.JSX.Element {
  const snapshot = useAppStore((s) => s.memorySnapshot)
  const memorySnapshotError = useAppStore((s) => s.memorySnapshotError)
  const fetchSnapshot = useAppStore((s) => s.fetchMemorySnapshot)
  const workspaceSessionReady = useAppStore((s) => s.workspaceSessionReady)
  const ptyIdsByTabId = useAppStore((s) => s.ptyIdsByTabId)

  const [open, setOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<TabKey>('resources')
  const [sortOption, setSortOption] = useState<SortOption>('memory')
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(new Set())
  const [collapsedWorktrees, setCollapsedWorktrees] = useState<Set<string>>(new Set())
  const [appCollapsed, setAppCollapsed] = useState(true)
  const [sessions, setSessions] = useState<DaemonSession[]>([])
  const [sessionsError, setSessionsError] = useState(false)

  const daemonActions = useDaemonActions({
    onRestartSettled: () => {
      // Why: after a restart, clear the stale error state so the error banner
      // disappears until the next poll confirms the new state.
      setSessionsError(false)
      void fetchSnapshot()
      void refreshSessions()
    },
    onKillAllSettled: () => {
      void refreshSessions()
    }
  })

  const refreshSessions = useCallback(async () => {
    try {
      const result = await window.api.pty.listSessions()
      setSessions(result)
      setSessionsError(false)
    } catch {
      setSessionsError(true)
    }
  }, [])

  // Poll memory + sessions when popover is open. Sessions also poll in the
  // background at a slower rate so the badge count stays reasonably fresh
  // without keeping the Memory IPC hot.
  useEffect(() => {
    if (!open) {
      return
    }
    void fetchSnapshot()
    void refreshSessions()
    const memTimer = window.setInterval(() => {
      void fetchSnapshot()
    }, POLL_MS)
    const sessTimer = window.setInterval(() => {
      void refreshSessions()
    }, SESSIONS_POLL_MS)
    return () => {
      window.clearInterval(memTimer)
      window.clearInterval(sessTimer)
    }
  }, [open, fetchSnapshot, refreshSessions])

  useEffect(() => {
    const interval = setInterval(() => void refreshSessions(), SESSIONS_POLL_MS)
    void refreshSessions()
    return () => clearInterval(interval)
  }, [refreshSessions])

  const boundPtyIds = useMemo(
    () => new Set(Object.values(ptyIdsByTabId).flat().filter(Boolean)),
    [ptyIdsByTabId]
  )
  const orphanCount = workspaceSessionReady
    ? sessions.filter((s) => !boundPtyIds.has(s.id)).length
    : 0

  const { totalMemory, totalCpu, hostShare, memBadgeLabel } = useMemo(() => {
    const memory = snapshot?.totalMemory ?? 0
    const cpu = snapshot?.totalCpu ?? 0
    const hostTotal = snapshot?.host.totalMemory ?? 0
    return {
      totalMemory: memory,
      totalCpu: cpu,
      hostShare: hostTotal > 0 ? (memory / hostTotal) * 100 : 0,
      memBadgeLabel: snapshot ? formatMemory(memory) : '—'
    }
  }, [snapshot])

  const daemonUnreachable = sessionsError && memorySnapshotError !== null

  const toggleRepo = useCallback((repoId: string): void => {
    setCollapsedRepos((prev) => {
      const next = new Set(prev)
      if (next.has(repoId)) {
        next.delete(repoId)
      } else {
        next.add(repoId)
      }
      return next
    })
  }, [])

  const toggleWorktree = useCallback((worktreeId: string): void => {
    setCollapsedWorktrees((prev) => {
      const next = new Set(prev)
      if (next.has(worktreeId)) {
        next.delete(worktreeId)
      } else {
        next.add(worktreeId)
      }
      return next
    })
  }, [])

  const navigateToWorktree = useCallback((worktreeId: string): void => {
    if (worktreeId === ORPHAN_WORKTREE_ID) {
      setOpen(false)
      return
    }
    const result = activateAndRevealWorktree(worktreeId)
    if (result === false) {
      return
    }
    setOpen(false)
  }, [])

  const deleteWorktree = useCallback((worktreeId: string): void => {
    setOpen(false)
    runWorktreeDelete(worktreeId)
  }, [])

  const handleSleep = useCallback((id: string): void => {
    void runSleepWorktree(id)
  }, [])

  const closeSegment = useCallback(() => {
    setOpen(false)
  }, [])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip delayDuration={150}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 cursor-pointer rounded px-1 py-0.5 hover:bg-accent/70"
              aria-label="Resource usage"
            >
              <MemoryStick className="size-3 text-muted-foreground" />
              {!iconOnly && (
                <>
                  <span className="text-[11px] font-medium tabular-nums text-muted-foreground">
                    {memBadgeLabel}
                  </span>
                  <span className="text-muted-foreground/50">·</span>
                  <Terminal className="size-3 text-muted-foreground" />
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {sessions.length}
                    {orphanCount > 0 && (
                      <span className="text-yellow-500 ml-0.5">({orphanCount})</span>
                    )}
                  </span>
                </>
              )}
              {iconOnly && sessions.length > 0 && (
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {sessions.length}
                </span>
              )}
              {daemonUnreachable && (
                <AlertTriangle className="size-3 text-yellow-500" aria-label="Daemon unreachable" />
              )}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          Resource usage — {memBadgeLabel} · {sessions.length} session
          {sessions.length === 1 ? '' : 's'}
        </TooltipContent>
      </Tooltip>

      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-[26rem] p-0"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {/* Why: header is the only chrome — left side carries an inline pill
            switcher between Resources and Sessions; right side carries the
            two daemon-control icons. The bulky Radix Tabs strip and the
            full-width footer were both removed because they created visual
            noise and competed with the data underneath. */}
        <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5">
          <div
            role="tablist"
            aria-label="Resource view"
            className="inline-flex items-center rounded-md bg-muted/40 p-0.5 text-[11px]"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'resources'}
              onClick={() => setActiveTab('resources')}
              className={cn(
                'inline-flex items-center gap-1 rounded px-2 py-0.5 transition-colors',
                activeTab === 'resources'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <MemoryStick className="size-3" />
              Resources
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'sessions'}
              onClick={() => setActiveTab('sessions')}
              className={cn(
                'inline-flex items-center gap-1 rounded px-2 py-0.5 transition-colors',
                activeTab === 'sessions'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Terminal className="size-3" />
              Sessions
              {orphanCount > 0 && (
                <span className="ml-0.5 text-yellow-500 tabular-nums">({orphanCount})</span>
              )}
            </button>
          </div>

          <div className="flex items-center gap-0.5">
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => daemonActions.setPending('restart')}
                  disabled={daemonActions.isBusy}
                  aria-label="Restart daemon"
                  className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                >
                  <RotateCw className="size-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                Restart daemon
              </TooltipContent>
            </Tooltip>
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => daemonActions.setPending('killAll')}
                  disabled={daemonActions.isBusy}
                  aria-label="Kill all sessions"
                  className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                >
                  <Trash2 className="size-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                Kill all sessions
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        {daemonUnreachable && (
          <div className="flex items-start gap-2 border-b border-border bg-yellow-500/10 px-3 py-2 text-[11px] text-foreground">
            <AlertTriangle className="mt-0.5 size-3 shrink-0 text-yellow-500" />
            <div className="flex-1">
              <div className="font-medium">Daemon is not responding</div>
              <div className="text-muted-foreground">
                Resource snapshots and terminal sessions are unavailable.
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => daemonActions.setPending('restart')}
              disabled={daemonActions.isBusy}
            >
              <RotateCw className="mr-1 size-3" />
              Restart
            </Button>
          </div>
        )}

        {snapshot && activeTab === 'resources' && (
          <div className="px-3 py-2 border-b border-border flex items-baseline gap-3 text-xs tabular-nums">
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <span
                  tabIndex={0}
                  className="font-medium text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:rounded"
                >
                  {formatCpu(totalCpu)}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6} className="z-[70] max-w-xs">
                Combined CPU load. Values above 100% mean more than one core is working at once.
              </TooltipContent>
            </Tooltip>
            <span className="text-muted-foreground/50">·</span>
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <span
                  tabIndex={0}
                  className="font-medium text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:rounded"
                >
                  {formatMemory(totalMemory)}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6} className="z-[70] max-w-xs">
                Resident memory held by Orca plus the processes under each worktree&apos;s
                terminals.
              </TooltipContent>
            </Tooltip>
            <span className="text-muted-foreground/50">·</span>
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <span
                  tabIndex={0}
                  className="text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:rounded"
                >
                  {formatPercent(hostShare)} of system RAM
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6} className="z-[70] max-w-xs">
                How much of this machine&apos;s physical RAM the Orca-tracked processes are sitting
                on.
              </TooltipContent>
            </Tooltip>
          </div>
        )}

        {/* Why: pin the body to a constant height so toggling between
            Resources and Sessions doesn't reflow the popover. The inner
            panels each take h-full and own their own scrolling, so short
            content (e.g. zero sessions) leaves whitespace instead of
            collapsing the surface. */}
        <div className="flex h-[420px] flex-col">
          {activeTab === 'resources' ? (
            <>
              {snapshot && (
                <div className="flex items-center justify-between px-3 py-1 bg-muted/30 border-b border-border/50 text-[10px] uppercase tracking-wide shrink-0">
                  <button
                    type="button"
                    onClick={() => setSortOption('name')}
                    className={cn(
                      'hover:text-foreground transition-colors',
                      sortOption === 'name'
                        ? 'font-semibold text-foreground'
                        : 'text-muted-foreground/80'
                    )}
                    aria-pressed={sortOption === 'name'}
                  >
                    Name
                  </button>
                  <div className={cn(METRIC_COLUMNS_CLS, 'text-[10px]')}>
                    <button
                      type="button"
                      onClick={() => setSortOption('cpu')}
                      className={cn(
                        CPU_COLUMN_CLS,
                        'hover:text-foreground transition-colors',
                        sortOption === 'cpu'
                          ? 'font-semibold text-foreground'
                          : 'text-muted-foreground/80'
                      )}
                      aria-pressed={sortOption === 'cpu'}
                    >
                      CPU
                    </button>
                    <button
                      type="button"
                      onClick={() => setSortOption('memory')}
                      className={cn(
                        MEM_COLUMN_CLS,
                        'hover:text-foreground transition-colors',
                        sortOption === 'memory'
                          ? 'font-semibold text-foreground'
                          : 'text-muted-foreground/80'
                      )}
                      aria-pressed={sortOption === 'memory'}
                    >
                      Memory
                    </button>
                  </div>
                </div>
              )}

              <div className="flex-1 overflow-y-auto scrollbar-sleek">
                {snapshot && snapshot.worktrees.length > 0 && (
                  <WorktreeSection
                    worktrees={snapshot.worktrees}
                    sortOption={sortOption}
                    collapsedRepos={collapsedRepos}
                    toggleRepo={toggleRepo}
                    collapsedWorktrees={collapsedWorktrees}
                    toggleWorktree={toggleWorktree}
                    navigateToWorktree={navigateToWorktree}
                    onSleep={handleSleep}
                    onDelete={deleteWorktree}
                  />
                )}

                {snapshot && snapshot.worktrees.length === 0 && (
                  <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                    Nothing running right now
                  </div>
                )}

                {snapshot && (
                  <AppSection
                    app={snapshot.app}
                    isCollapsed={appCollapsed}
                    onToggle={() => setAppCollapsed((v) => !v)}
                  />
                )}

                {!snapshot && !daemonUnreachable && (
                  <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                    Loading…
                  </div>
                )}
              </div>
            </>
          ) : (
            <SessionsTabPanel
              sessions={sessions}
              sessionsError={sessionsError}
              onCloseSegment={closeSegment}
              onSessionsChanged={() => void refreshSessions()}
            />
          )}
        </div>
      </PopoverContent>
      <DaemonActionDialog api={daemonActions} />
    </Popover>
  )
}
