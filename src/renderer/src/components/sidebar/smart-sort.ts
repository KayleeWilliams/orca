import { detectAgentStatusFromTitle, isExplicitAgentStatusFresh } from '@/lib/agent-status'
import { branchName } from '@/lib/git-utils'
import type { Worktree, Repo, TerminalTab } from '../../../../shared/types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'

type SortBy = 'name' | 'smart' | 'recent' | 'repo'

type PRCacheEntry = { data: object | null; fetchedAt: number }
export type SmartSortOverride = {
  worktree: Worktree
  tabs: TerminalTab[]
  hasRecentPRSignal: boolean
}

export function hasRecentPRSignal(
  worktree: Worktree,
  repoMap: Map<string, Repo>,
  prCache: Record<string, PRCacheEntry> | null
): boolean {
  const repo = repoMap.get(worktree.repoId)
  const branch = branchName(worktree.branch)
  if (!repo || !branch) {
    return worktree.linkedPR !== null
  }

  const cacheKey = `${repo.path}::${branch}`
  const cachedEntry = prCache?.[cacheKey]
  if (cachedEntry) {
    return Boolean(cachedEntry.data)
  }

  return worktree.linkedPR !== null
}

function computeSmartScoreFromSignals(
  worktree: Worktree,
  tabs: TerminalTab[],
  hasRecentPR: boolean,
  now: number,
  agentStatusByPaneKey?: Record<string, AgentStatusEntry>
): number {
  const liveTabs = tabs.filter((t) => t.ptyId)

  let score = 0

  // Why: explicit agent status (OSC 9999) is authoritative over heuristic title
  // parsing. Check explicit status first; fall through to heuristics for tabs
  // that have no explicit status entry.
  const explicitEntries = agentStatusByPaneKey
    ? Object.values(agentStatusByPaneKey).filter((e) =>
        tabs.some((t) => e.paneKey.startsWith(`${t.id}:`))
      )
    : []
  const explicitByTabId = new Map<string, AgentStatusEntry[]>()
  for (const entry of explicitEntries) {
    const colonIndex = entry.paneKey.indexOf(':')
    const tabId = colonIndex === -1 ? entry.paneKey : entry.paneKey.slice(0, colonIndex)
    const existing = explicitByTabId.get(tabId)
    if (existing) {
      existing.push(entry)
    } else {
      explicitByTabId.set(tabId, [entry])
    }
  }

  let hasExplicitWorking = false
  let hasExplicitBlocked = false
  let hasHeuristicWorking = false
  let hasHeuristicBlocked = false

  for (const tab of liveTabs) {
    const tabExplicitEntries = explicitByTabId.get(tab.id) ?? []
    // Why: compute freshness once per entry instead of recomputing inside each
    // of the three `.some(...)` passes below. Freshness is a pure function of
    // (entry, now) so filtering up front is equivalent and cheaper.
    const freshEntries = tabExplicitEntries.filter((entry) =>
      isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)
    )

    if (freshEntries.length > 0) {
      hasExplicitWorking ||= freshEntries.some((entry) => entry.state === 'working')
      hasExplicitBlocked ||= freshEntries.some(
        (entry) => entry.state === 'blocked' || entry.state === 'waiting'
      )
      continue
    }

    const heuristicState = detectAgentStatusFromTitle(tab.title)
    hasHeuristicWorking ||= heuristicState === 'working'
    hasHeuristicBlocked ||= heuristicState === 'permission'
  }

  // Explicit working → +60, same weight as heuristic working
  // Explicit blocked/waiting → +35, same weight as heuristic permission
  // Explicit done → no bonus (task complete, no attention needed)
  const isRunning = hasExplicitWorking || hasHeuristicWorking
  if (isRunning) {
    score += 60
  }

  const needsAttention = hasExplicitBlocked || hasHeuristicBlocked
  if (needsAttention) {
    score += 35
  }

  if (worktree.isUnread) {
    score += 18
  }

  if (liveTabs.length > 0) {
    score += 12
  }

  if (hasRecentPR) {
    score += 10
  }

  if (worktree.linkedIssue !== null) {
    score += 6
  }

  const activityAge = now - (worktree.lastActivityAt || 0)
  if (worktree.lastActivityAt > 0) {
    const ONE_DAY = 24 * 60 * 60 * 1000
    // Why 36: a just-created worktree has only this signal (no live tab yet,
    // since the PTY spawns asynchronously after creation). Weight must exceed
    // the max passive-signal combination for shutdown worktrees
    // (isUnread 18 + PR 10 + issue 6 = 34) so brand-new worktrees always
    // appear at the top of the "smart" sort immediately.
    score += 36 * Math.max(0, 1 - activityAge / ONE_DAY)
  }

  return score
}

function getSmartSortCandidate(
  worktree: Worktree,
  tabsByWorktree: Record<string, TerminalTab[]> | null,
  repoMap: Map<string, Repo>,
  prCache: Record<string, PRCacheEntry> | null,
  smartSortOverrides: Record<string, SmartSortOverride> | null
): SmartSortOverride {
  return (
    smartSortOverrides?.[worktree.id] ?? {
      worktree,
      tabs: tabsByWorktree?.[worktree.id] ?? [],
      hasRecentPRSignal: hasRecentPRSignal(worktree, repoMap, prCache)
    }
  )
}

/**
 * Build a comparator for sorting worktrees based on the current sort mode.
 *
 * `precomputedScores` is the decorate-sort-undecorate optimization for the
 * `smart` mode: callers should compute each worktree's smart score once and
 * pass the map in, since `Array.prototype.sort` invokes the comparator
 * O(N log N) times and recomputing the score each call scans the
 * `agentStatusByPaneKey` map O(N log N × E) times. When omitted, the
 * comparator falls back to computing scores per-comparison so existing call
 * sites that haven't adopted the optimization keep working.
 */
export function buildWorktreeComparator(
  sortBy: SortBy,
  tabsByWorktree: Record<string, TerminalTab[]> | null,
  repoMap: Map<string, Repo>,
  prCache: Record<string, PRCacheEntry> | null,
  now: number = Date.now(),
  smartSortOverrides: Record<string, SmartSortOverride> | null = null,
  agentStatusByPaneKey?: Record<string, AgentStatusEntry>,
  precomputedScores?: Map<string, number>
): (a: Worktree, b: Worktree) => number {
  return (a, b) => {
    switch (sortBy) {
      case 'name':
        return a.displayName.localeCompare(b.displayName)
      case 'smart': {
        const smartA = getSmartSortCandidate(
          a,
          tabsByWorktree,
          repoMap,
          prCache,
          smartSortOverrides
        )
        const smartB = getSmartSortCandidate(
          b,
          tabsByWorktree,
          repoMap,
          prCache,
          smartSortOverrides
        )
        // Why precomputedScores: the smart-score computation iterates
        // `agentStatusByPaneKey` (O(E) per call). The comparator is invoked
        // O(N log N) times by Array.sort, so without memoization we pay
        // O(N log N × E). When the caller supplies a precomputed score map
        // we get O(1) lookups; when it doesn't we preserve the old behavior
        // to stay backward-compatible. Overrides bypass the precomputed map
        // because the override intentionally freezes the candidate's inputs
        // (tabs, hasRecentPRSignal) which may differ from the live score.
        const scoreA =
          precomputedScores && !smartSortOverrides?.[a.id]
            ? (precomputedScores.get(a.id) ?? 0)
            : computeSmartScoreFromSignals(
                smartA.worktree,
                smartA.tabs,
                smartA.hasRecentPRSignal,
                now,
                agentStatusByPaneKey
              )
        const scoreB =
          precomputedScores && !smartSortOverrides?.[b.id]
            ? (precomputedScores.get(b.id) ?? 0)
            : computeSmartScoreFromSignals(
                smartB.worktree,
                smartB.tabs,
                smartB.hasRecentPRSignal,
                now,
                agentStatusByPaneKey
              )
        return (
          scoreB - scoreA ||
          smartB.worktree.lastActivityAt - smartA.worktree.lastActivityAt ||
          a.displayName.localeCompare(b.displayName)
        )
      }
      case 'recent':
        // Why lastActivityAt (not sortOrder): sortOrder is a snapshot of the
        // smart-sort ranking that only gets repersisted while the user is in
        // "Smart" mode, so it's frozen in Recent mode and ignores new terminal
        // events, meta edits, etc. lastActivityAt is the real "recency" signal
        // — it's bumped by bumpWorktreeActivity (PTY spawn, background events)
        // and by meaningful meta edits (comment, isUnread).
        return b.lastActivityAt - a.lastActivityAt || a.displayName.localeCompare(b.displayName)
      case 'repo': {
        const ra = repoMap.get(a.repoId)?.displayName ?? ''
        const rb = repoMap.get(b.repoId)?.displayName ?? ''
        const cmp = ra.localeCompare(rb)
        return cmp !== 0 ? cmp : a.displayName.localeCompare(b.displayName)
      }
      default: {
        const _exhaustive: never = sortBy
        return _exhaustive
      }
    }
  }
}

/**
 * Sort worktrees by weighted smart-score signals, handling the cold-start /
 * warm distinction in one place. On cold start (no live PTYs yet), falls back
 * to persisted `sortOrder` descending with alphabetical `displayName` fallback.
 * Once any PTY is alive, uses the full smart-score comparator.
 *
 * Both the palette and `getVisibleWorktreeIds()` import this to avoid
 * duplicating the cold/warm branching logic.
 */
export function sortWorktreesSmart(
  worktrees: Worktree[],
  tabsByWorktree: Record<string, TerminalTab[]>,
  repoMap: Map<string, Repo>,
  prCache: Record<string, PRCacheEntry> | null,
  agentStatusByPaneKey?: Record<string, AgentStatusEntry>
): Worktree[] {
  const hasAnyLivePty = Object.values(tabsByWorktree)
    .flat()
    .some((t) => t.ptyId)

  if (!hasAnyLivePty) {
    // Cold start: use persisted sortOrder snapshot
    return [...worktrees].sort(
      (a, b) => b.sortOrder - a.sortOrder || a.displayName.localeCompare(b.displayName)
    )
  }

  // Why precompute: Array.sort calls the comparator O(N log N) times and the
  // smart-score computation iterates `agentStatusByPaneKey` each time. Compute
  // each worktree's score once up front (decorate-sort-undecorate) so the
  // comparator does O(1) map lookups instead of O(E) scans per comparison.
  const now = Date.now()
  const precomputedScores = new Map<string, number>(
    worktrees.map((w) => [
      w.id,
      computeSmartScore(w, tabsByWorktree, repoMap, prCache, now, agentStatusByPaneKey)
    ])
  )

  // Why: agentStatusByPaneKey is forwarded so the smart-score comparator can
  // use explicit agent status (OSC 9999) when ranking worktrees by recency.
  return [...worktrees].sort(
    buildWorktreeComparator(
      'smart',
      tabsByWorktree,
      repoMap,
      prCache,
      now,
      null,
      agentStatusByPaneKey,
      precomputedScores
    )
  )
}

/**
 * Compute a recent-work score for a worktree.
 * Higher score = higher in the list.
 *
 * Scoring:
 *   running AI job    → +60
 *   recent activity   → +36 (decays over 24 hours)
 *   needs attention   → +35
 *   unread            → +18
 *   open terminal     → +12
 *   live branch PR    → +10
 *   linked issue      → +6
 */
export function computeSmartScore(
  worktree: Worktree,
  tabsByWorktree: Record<string, TerminalTab[]> | null,
  repoMap: Map<string, Repo> | null,
  prCache: Record<string, PRCacheEntry> | null,
  now: number = Date.now(),
  agentStatusByPaneKey?: Record<string, AgentStatusEntry>
): number {
  return computeSmartScoreFromSignals(
    worktree,
    tabsByWorktree?.[worktree.id] ?? [],
    // Why: branch-aware PR cache is the freshest signal, but off-screen
    // worktrees may not have fetched it yet. Fall back to persisted linkedPR
    // only while that branch cache entry is still cold so smart sorting stays
    // stable on launch without reviving stale PRs after a cache miss resolves.
    repoMap ? hasRecentPRSignal(worktree, repoMap, prCache) : worktree.linkedPR !== null,
    now,
    agentStatusByPaneKey
  )
}
