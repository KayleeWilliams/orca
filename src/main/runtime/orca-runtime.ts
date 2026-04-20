/* eslint-disable max-lines -- Why: the Orca runtime is the authoritative live control plane for the CLI, so handle validation, selector resolution, wait state, and summaries are kept together to avoid split-brain behavior. */
/* eslint-disable unicorn/no-useless-spread -- Why: waiter sets and handle keys are cloned intentionally before mutation so resolution and rejection can safely remove entries while iterating. */
/* eslint-disable no-control-regex -- Why: terminal normalization must strip ANSI and OSC control sequences from PTY output before returning bounded text to agents. */
import { gitExecFileAsync, gitExecFileSync } from '../git/runner'
import { isWslPath, parseWslPath, getWslHome } from '../wsl'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { rm } from 'fs/promises'
import type { CreateWorktreeResult, Repo } from '../../shared/types'
import { isFolderRepo } from '../../shared/repo-kind'
import type {
  RuntimeGraphStatus,
  RuntimeRepoSearchRefs,
  RuntimeTerminalRead,
  RuntimeTerminalSend,
  RuntimeTerminalListResult,
  RuntimeTerminalState,
  RuntimeStatus,
  RuntimeTerminalWait,
  RuntimeWorktreePsSummary,
  RuntimeTerminalShow,
  RuntimeTerminalSummary,
  RuntimeSyncedLeaf,
  RuntimeSyncedTab,
  RuntimeSyncWindowGraph,
  RuntimeWorktreeListResult,
  BrowserSnapshotResult,
  BrowserClickResult,
  BrowserGotoResult,
  BrowserFillResult,
  BrowserTypeResult,
  BrowserSelectResult,
  BrowserScrollResult,
  BrowserBackResult,
  BrowserReloadResult,
  BrowserScreenshotResult,
  BrowserEvalResult,
  BrowserTabListResult,
  BrowserTabSwitchResult,
  BrowserHoverResult,
  BrowserDragResult,
  BrowserUploadResult,
  BrowserWaitResult,
  BrowserCheckResult,
  BrowserFocusResult,
  BrowserClearResult,
  BrowserSelectAllResult,
  BrowserKeypressResult,
  BrowserPdfResult,
  BrowserCookieGetResult,
  BrowserCookieSetResult,
  BrowserCookieDeleteResult,
  BrowserViewportResult,
  BrowserGeolocationResult,
  BrowserInterceptEnableResult,
  BrowserInterceptDisableResult,
  BrowserCaptureStartResult,
  BrowserCaptureStopResult,
  BrowserConsoleResult,
  BrowserNetworkLogResult
} from '../../shared/runtime-types'
import { BrowserWindow, ipcMain } from 'electron'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import { waitForTabRegistration } from '../ipc/browser'
import { getPRForBranch } from '../github/client'
import {
  getGitUsername,
  getDefaultBaseRef,
  getBranchConflictKind,
  isGitRepo,
  getRepoName,
  searchBaseRefs
} from '../git/repo'
import { listWorktrees, addWorktree, removeWorktree } from '../git/worktree'
import { createSetupRunnerScript, getEffectiveHooks, runHook } from '../hooks'
import { REPO_COLORS } from '../../shared/constants'
import { listRepoWorktrees } from '../repo-worktrees'
import type { Store } from '../persistence'
import type { StatsCollector } from '../stats/collector'
import { AgentDetector } from '../stats/agent-detector'
import {
  computeBranchName,
  computeWorktreePath,
  ensurePathWithinWorkspace,
  formatWorktreeRemovalError,
  isOrphanedWorktreeError,
  mergeWorktree,
  sanitizeWorktreeName,
  shouldSetDisplayName,
  areWorktreePathsEqual
} from '../ipc/worktree-logic'
import { invalidateAuthorizedRootsCache } from '../ipc/filesystem-auth'

type RuntimeStore = {
  getRepos: Store['getRepos']
  getRepo: Store['getRepo']
  addRepo: Store['addRepo']
  updateRepo: Store['updateRepo']
  getAllWorktreeMeta: Store['getAllWorktreeMeta']
  getWorktreeMeta: Store['getWorktreeMeta']
  setWorktreeMeta: Store['setWorktreeMeta']
  removeWorktreeMeta: Store['removeWorktreeMeta']
  getSettings(): {
    workspaceDir: string
    nestWorkspaces: boolean
    refreshLocalBaseRefOnWorktreeCreate: boolean
    branchPrefix: string
    branchPrefixCustom: string
  }
}

type RuntimeLeafRecord = RuntimeSyncedLeaf & {
  ptyGeneration: number
  connected: boolean
  writable: boolean
  lastOutputAt: number | null
  lastExitCode: number | null
  tailBuffer: string[]
  tailPartialLine: string
  tailTruncated: boolean
  preview: string
}

type RuntimePtyController = {
  write(ptyId: string, data: string): boolean
  kill(ptyId: string): boolean
}

type RuntimeNotifier = {
  worktreesChanged(repoId: string): void
  reposChanged(): void
  activateWorktree(repoId: string, worktreeId: string, setup?: CreateWorktreeResult['setup']): void
}

type TerminalHandleRecord = {
  handle: string
  runtimeId: string
  rendererGraphEpoch: number
  worktreeId: string
  tabId: string
  leafId: string
  ptyId: string | null
  ptyGeneration: number
}

type TerminalWaiter = {
  handle: string
  resolve: (result: RuntimeTerminalWait) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout | null
}

type ResolvedWorktree = {
  id: string
  repoId: string
  path: string
  branch: string
  linkedIssue: number | null
  git: {
    path: string
    head: string
    branch: string
    isBare: boolean
    isMainWorktree: boolean
  }
  displayName: string
  comment: string
}

type ResolvedWorktreeCache = {
  expiresAt: number
  worktrees: ResolvedWorktree[]
}

export class OrcaRuntimeService {
  private readonly runtimeId = randomUUID()
  private readonly startedAt = Date.now()
  private readonly store: RuntimeStore | null
  private rendererGraphEpoch = 0
  private graphStatus: RuntimeGraphStatus = 'unavailable'
  private authoritativeWindowId: number | null = null
  private tabs = new Map<string, RuntimeSyncedTab>()
  private leaves = new Map<string, RuntimeLeafRecord>()
  private handles = new Map<string, TerminalHandleRecord>()
  private handleByLeafKey = new Map<string, string>()
  private waitersByHandle = new Map<string, Set<TerminalWaiter>>()
  private ptyController: RuntimePtyController | null = null
  private notifier: RuntimeNotifier | null = null
  private agentBrowserBridge: AgentBrowserBridge | null = null
  private resolvedWorktreeCache: ResolvedWorktreeCache | null = null
  private agentDetector: AgentDetector | null = null

  constructor(store: RuntimeStore | null = null, stats?: StatsCollector) {
    this.store = store
    if (stats) {
      this.agentDetector = new AgentDetector(stats)
    }
  }

  getRuntimeId(): string {
    return this.runtimeId
  }

  getStartedAt(): number {
    return this.startedAt
  }

  getStatus(): RuntimeStatus {
    return {
      runtimeId: this.runtimeId,
      rendererGraphEpoch: this.rendererGraphEpoch,
      graphStatus: this.graphStatus,
      authoritativeWindowId: this.authoritativeWindowId,
      liveTabCount: this.tabs.size,
      liveLeafCount: this.leaves.size
    }
  }

  setPtyController(controller: RuntimePtyController | null): void {
    // Why: CLI terminal writes must go through the main-owned PTY registry
    // instead of tunneling back through renderer IPC, or live handles could
    // drift from the process they are supposed to control during reloads.
    this.ptyController = controller
  }

  setNotifier(notifier: RuntimeNotifier | null): void {
    this.notifier = notifier
  }

  setAgentBrowserBridge(bridge: AgentBrowserBridge | null): void {
    this.agentBrowserBridge = bridge
  }

  getAgentBrowserBridge(): AgentBrowserBridge | null {
    return this.agentBrowserBridge
  }

  attachWindow(windowId: number): void {
    if (this.authoritativeWindowId === null) {
      this.authoritativeWindowId = windowId
    }
  }

  syncWindowGraph(windowId: number, graph: RuntimeSyncWindowGraph): RuntimeStatus {
    if (this.authoritativeWindowId === null) {
      this.authoritativeWindowId = windowId
    }
    if (windowId !== this.authoritativeWindowId) {
      throw new Error('Runtime graph publisher does not match the authoritative window')
    }

    this.tabs = new Map(graph.tabs.map((tab) => [tab.tabId, tab]))
    const nextLeaves = new Map<string, RuntimeLeafRecord>()

    for (const leaf of graph.leaves) {
      const leafKey = this.getLeafKey(leaf.tabId, leaf.leafId)
      const existing = this.leaves.get(leafKey)
      const ptyGeneration =
        existing && existing.ptyId !== leaf.ptyId
          ? existing.ptyGeneration + 1
          : (existing?.ptyGeneration ?? 0)

      nextLeaves.set(leafKey, {
        ...leaf,
        ptyGeneration,
        connected: leaf.ptyId !== null,
        writable: this.graphStatus === 'ready' && leaf.ptyId !== null,
        lastOutputAt: existing?.ptyId === leaf.ptyId ? existing.lastOutputAt : null,
        lastExitCode: existing?.ptyId === leaf.ptyId ? existing.lastExitCode : null,
        tailBuffer: existing?.ptyId === leaf.ptyId ? existing.tailBuffer : [],
        tailPartialLine: existing?.ptyId === leaf.ptyId ? existing.tailPartialLine : '',
        tailTruncated: existing?.ptyId === leaf.ptyId ? existing.tailTruncated : false,
        preview: existing?.ptyId === leaf.ptyId ? existing.preview : ''
      })

      if (existing && (existing.ptyId !== leaf.ptyId || existing.ptyGeneration !== ptyGeneration)) {
        this.invalidateLeafHandle(leafKey)
      }
    }

    for (const oldLeafKey of this.leaves.keys()) {
      if (!nextLeaves.has(oldLeafKey)) {
        this.invalidateLeafHandle(oldLeafKey)
      }
    }

    this.leaves = nextLeaves
    this.graphStatus = 'ready'
    this.refreshWritableFlags()
    return this.getStatus()
  }

  onPtySpawned(ptyId: string): void {
    for (const leaf of this.leaves.values()) {
      if (leaf.ptyId === ptyId) {
        leaf.connected = true
        leaf.writable = this.graphStatus === 'ready'
      }
    }
  }

  onPtyData(ptyId: string, data: string, at: number): void {
    // Agent detection runs on raw data before leaf processing, since the
    // tail buffer logic normalizes away the OSC sequences we need.
    this.agentDetector?.onData(ptyId, data, at)

    for (const leaf of this.leaves.values()) {
      if (leaf.ptyId !== ptyId) {
        continue
      }
      leaf.connected = true
      leaf.writable = this.graphStatus === 'ready'
      leaf.lastOutputAt = at
      const nextTail = appendToTailBuffer(leaf.tailBuffer, leaf.tailPartialLine, data)
      leaf.tailBuffer = nextTail.lines
      leaf.tailPartialLine = nextTail.partialLine
      leaf.tailTruncated = leaf.tailTruncated || nextTail.truncated
      leaf.preview = buildPreview(leaf.tailBuffer, leaf.tailPartialLine)
    }
  }

  onPtyExit(ptyId: string, exitCode: number): void {
    this.agentDetector?.onExit(ptyId)

    for (const leaf of this.leaves.values()) {
      if (leaf.ptyId !== ptyId) {
        continue
      }
      leaf.connected = false
      leaf.writable = false
      leaf.lastExitCode = exitCode
      this.resolveExitWaiters(leaf)
    }
  }

  async listTerminals(
    worktreeSelector?: string,
    limit = DEFAULT_TERMINAL_LIST_LIMIT
  ): Promise<RuntimeTerminalListResult> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('invalid_limit')
    }
    const graphEpoch = this.captureReadyGraphEpoch()
    const targetWorktreeId = worktreeSelector
      ? (await this.resolveWorktreeSelector(worktreeSelector)).id
      : null
    const worktreesById = await this.getResolvedWorktreeMap()
    this.assertStableReadyGraph(graphEpoch)

    const terminals: RuntimeTerminalSummary[] = []
    for (const leaf of this.leaves.values()) {
      if (targetWorktreeId && leaf.worktreeId !== targetWorktreeId) {
        continue
      }
      terminals.push(this.buildTerminalSummary(leaf, worktreesById))
    }
    return {
      terminals: terminals.slice(0, limit),
      totalCount: terminals.length,
      truncated: terminals.length > limit
    }
  }

  async showTerminal(handle: string): Promise<RuntimeTerminalShow> {
    const graphEpoch = this.captureReadyGraphEpoch()
    const worktreesById = await this.getResolvedWorktreeMap()
    this.assertStableReadyGraph(graphEpoch)
    const { leaf } = this.getLiveLeafForHandle(handle)
    const summary = this.buildTerminalSummary(leaf, worktreesById)
    return {
      ...summary,
      paneRuntimeId: leaf.paneRuntimeId,
      ptyId: leaf.ptyId,
      rendererGraphEpoch: this.rendererGraphEpoch
    }
  }

  async readTerminal(handle: string): Promise<RuntimeTerminalRead> {
    const { leaf } = this.getLiveLeafForHandle(handle)
    const tail = buildTailLines(leaf.tailBuffer, leaf.tailPartialLine)
    return {
      handle,
      status: getTerminalState(leaf),
      // Why: Orca does not have a truthful main-owned screen model yet,
      // especially for hidden panes. Focused v1 therefore returns the bounded
      // tail lines directly instead of duplicating the same text in a fake
      // screen field that would waste agent tokens.
      tail,
      truncated: leaf.tailTruncated,
      nextCursor: null
    }
  }

  async sendTerminal(
    handle: string,
    action: {
      text?: string
      enter?: boolean
      interrupt?: boolean
    }
  ): Promise<RuntimeTerminalSend> {
    const { leaf } = this.getLiveLeafForHandle(handle)
    if (!leaf.writable || !leaf.ptyId) {
      throw new Error('terminal_not_writable')
    }
    const payload = buildSendPayload(action)
    if (payload === null) {
      throw new Error('invalid_terminal_send')
    }
    const wrote = this.ptyController?.write(leaf.ptyId, payload) ?? false
    if (!wrote) {
      throw new Error('terminal_not_writable')
    }
    return {
      handle,
      accepted: true,
      bytesWritten: Buffer.byteLength(payload, 'utf8')
    }
  }

  async waitForTerminal(
    handle: string,
    options?: {
      timeoutMs?: number
    }
  ): Promise<RuntimeTerminalWait> {
    const { leaf } = this.getLiveLeafForHandle(handle)
    if (getTerminalState(leaf) === 'exited') {
      return buildTerminalWaitResult(handle, leaf)
    }

    return await new Promise<RuntimeTerminalWait>((resolve, reject) => {
      const waiter: TerminalWaiter = {
        handle,
        resolve,
        reject,
        timeout: null
      }

      if (typeof options?.timeoutMs === 'number' && options.timeoutMs > 0) {
        waiter.timeout = setTimeout(() => {
          this.removeWaiter(waiter)
          reject(new Error('timeout'))
        }, options.timeoutMs)
      }

      let waiters = this.waitersByHandle.get(handle)
      if (!waiters) {
        waiters = new Set()
        this.waitersByHandle.set(handle, waiters)
      }
      waiters.add(waiter)

      // Why: the handle may go stale or exit in the small gap between the first
      // validation and waiter registration. Re-checking here keeps wait --for
      // exit honest instead of hanging on a terminal that already changed.
      try {
        const live = this.getLiveLeafForHandle(handle)
        if (getTerminalState(live.leaf) === 'exited') {
          this.resolveWaiter(waiter, buildTerminalWaitResult(handle, live.leaf))
        }
      } catch (error) {
        this.removeWaiter(waiter)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async getWorktreePs(limit = DEFAULT_WORKTREE_PS_LIMIT): Promise<{
    worktrees: RuntimeWorktreePsSummary[]
    totalCount: number
    truncated: boolean
  }> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('invalid_limit')
    }
    const resolvedWorktrees = await this.listResolvedWorktrees()
    const repoById = new Map((this.store?.getRepos() ?? []).map((repo) => [repo.id, repo]))
    const summaries = new Map<string, RuntimeWorktreePsSummary>()

    for (const worktree of resolvedWorktrees) {
      const meta =
        this.store?.getWorktreeMeta?.(worktree.id) ?? this.store?.getAllWorktreeMeta()[worktree.id]
      summaries.set(worktree.id, {
        worktreeId: worktree.id,
        repoId: worktree.repoId,
        repo: repoById.get(worktree.repoId)?.displayName ?? worktree.repoId,
        path: worktree.path,
        branch: worktree.branch,
        linkedIssue: worktree.linkedIssue,
        unread: meta?.isUnread ?? false,
        liveTerminalCount: 0,
        hasAttachedPty: false,
        lastOutputAt: null,
        preview: ''
      })
    }

    for (const leaf of this.leaves.values()) {
      const summary = summaries.get(leaf.worktreeId)
      if (!summary) {
        continue
      }
      const previousLastOutputAt = summary.lastOutputAt
      summary.liveTerminalCount += 1
      summary.hasAttachedPty = summary.hasAttachedPty || leaf.connected
      summary.lastOutputAt = maxTimestamp(summary.lastOutputAt, leaf.lastOutputAt)
      if (
        leaf.preview &&
        (summary.preview.length === 0 || (leaf.lastOutputAt ?? -1) >= (previousLastOutputAt ?? -1))
      ) {
        summary.preview = leaf.preview
      }
    }

    const sorted = [...summaries.values()].sort(compareWorktreePs)
    return {
      worktrees: sorted.slice(0, limit),
      totalCount: sorted.length,
      truncated: sorted.length > limit
    }
  }

  listRepos(): Repo[] {
    return this.store?.getRepos() ?? []
  }

  async addRepo(path: string, kind: 'git' | 'folder' = 'git'): Promise<Repo> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    if (kind === 'git' && !isGitRepo(path)) {
      throw new Error(`Not a valid git repository: ${path}`)
    }

    const existing = this.store.getRepos().find((repo) => repo.path === path)
    if (existing) {
      return existing
    }

    const repo: Repo = {
      id: randomUUID(),
      path,
      displayName: getRepoName(path),
      badgeColor: REPO_COLORS[this.store.getRepos().length % REPO_COLORS.length],
      addedAt: Date.now(),
      kind
    }
    this.store.addRepo(repo)
    this.invalidateResolvedWorktreeCache()
    this.notifier?.reposChanged()
    return this.store.getRepo(repo.id) ?? repo
  }

  async showRepo(repoSelector: string): Promise<Repo> {
    return await this.resolveRepoSelector(repoSelector)
  }

  async setRepoBaseRef(repoSelector: string, baseRef: string): Promise<Repo> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    const repo = await this.resolveRepoSelector(repoSelector)
    if (isFolderRepo(repo)) {
      throw new Error('Folder mode does not support base refs.')
    }
    const updated = this.store.updateRepo(repo.id, { worktreeBaseRef: baseRef })
    if (!updated) {
      throw new Error('repo_not_found')
    }
    this.invalidateResolvedWorktreeCache()
    this.notifier?.reposChanged()
    return updated
  }

  async searchRepoRefs(
    repoSelector: string,
    query: string,
    limit = DEFAULT_REPO_SEARCH_REFS_LIMIT
  ): Promise<RuntimeRepoSearchRefs> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('invalid_limit')
    }
    const repo = await this.resolveRepoSelector(repoSelector)
    if (isFolderRepo(repo)) {
      return {
        refs: [],
        truncated: false
      }
    }
    const refs = await searchBaseRefs(repo.path, query, limit + 1)
    return {
      refs: refs.slice(0, limit),
      truncated: refs.length > limit
    }
  }

  async listManagedWorktrees(
    repoSelector?: string,
    limit = DEFAULT_WORKTREE_LIST_LIMIT
  ): Promise<RuntimeWorktreeListResult> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('invalid_limit')
    }
    const resolved = await this.listResolvedWorktrees()
    const repoId = repoSelector ? (await this.resolveRepoSelector(repoSelector)).id : null
    const worktrees = resolved.filter((worktree) => !repoId || worktree.repoId === repoId)
    return {
      worktrees: worktrees.slice(0, limit),
      totalCount: worktrees.length,
      truncated: worktrees.length > limit
    }
  }

  async showManagedWorktree(worktreeSelector: string) {
    return await this.resolveWorktreeSelector(worktreeSelector)
  }

  async createManagedWorktree(args: {
    repoSelector: string
    name: string
    baseBranch?: string
    linkedIssue?: number | null
    comment?: string
  }): Promise<CreateWorktreeResult> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }

    const repo = await this.resolveRepoSelector(args.repoSelector)
    if (isFolderRepo(repo)) {
      throw new Error('Folder mode does not support creating worktrees.')
    }
    const settings = this.store.getSettings()
    const requestedName = args.name
    const sanitizedName = sanitizeWorktreeName(args.name)
    const username = getGitUsername(repo.path)
    const branchName = computeBranchName(sanitizedName, settings, username)

    const branchConflictKind = await getBranchConflictKind(repo.path, branchName)
    if (branchConflictKind) {
      throw new Error(
        `Branch "${branchName}" already exists ${branchConflictKind === 'local' ? 'locally' : 'on a remote'}.`
      )
    }

    let existingPR: Awaited<ReturnType<typeof getPRForBranch>> | null = null
    try {
      existingPR = await getPRForBranch(repo.path, branchName)
    } catch {
      // Why: worktree creation should not hard-fail on transient GitHub reachability
      // issues because git state is still the source of truth for whether the
      // worktree can be created locally.
    }
    if (existingPR) {
      throw new Error(`Branch "${branchName}" already has PR #${existingPR.number}.`)
    }

    let worktreePath = computeWorktreePath(sanitizedName, repo.path, settings)
    // Why: CLI-managed WSL worktrees live under ~/orca/workspaces inside the
    // distro filesystem. If home lookup fails, still validate against the
    // configured workspace dir so the traversal guard is never bypassed.
    const wslInfo = isWslPath(repo.path) ? parseWslPath(repo.path) : null
    const wslHome = wslInfo ? getWslHome(wslInfo.distro) : null
    const workspaceRoot = wslHome ? join(wslHome, 'orca', 'workspaces') : settings.workspaceDir
    worktreePath = ensurePathWithinWorkspace(worktreePath, workspaceRoot)
    const baseBranch = args.baseBranch || repo.worktreeBaseRef || getDefaultBaseRef(repo.path)

    const remote = baseBranch.includes('/') ? baseBranch.split('/')[0] : 'origin'
    try {
      gitExecFileSync(['fetch', remote], { cwd: repo.path })
    } catch {
      // Why: matching the editor behavior keeps CLI creation usable offline.
    }

    await addWorktree(
      repo.path,
      worktreePath,
      branchName,
      baseBranch,
      settings.refreshLocalBaseRefOnWorktreeCreate
    )
    const gitWorktrees = await listWorktrees(repo.path)
    const created = gitWorktrees.find((gw) => areWorktreePathsEqual(gw.path, worktreePath))
    if (!created) {
      throw new Error('Worktree created but not found in listing')
    }

    const worktreeId = `${repo.id}::${created.path}`
    const meta = this.store.setWorktreeMeta(worktreeId, {
      lastActivityAt: Date.now(),
      ...(shouldSetDisplayName(requestedName, branchName, sanitizedName)
        ? { displayName: requestedName }
        : {}),
      ...(args.linkedIssue !== undefined ? { linkedIssue: args.linkedIssue } : {}),
      ...(args.comment !== undefined ? { comment: args.comment } : {})
    })
    const worktree = mergeWorktree(repo.id, created, meta)

    let setup: CreateWorktreeResult['setup']
    const hooks = getEffectiveHooks(repo)
    if (hooks?.scripts.setup) {
      if (this.authoritativeWindowId !== null) {
        try {
          // Why: CLI-created worktrees must use the same runner-script path as the
          // renderer create flow so repo-committed `orca.yaml` setup hooks run in
          // the visible first terminal instead of a hidden background shell with
          // different failure and prompt behavior.
          setup = createSetupRunnerScript(repo, worktreePath, hooks.scripts.setup)
        } catch (error) {
          // Why: the git worktree is already real at this point. If runner
          // generation fails, keep creation successful and surface the problem in
          // logs rather than pretending the worktree was never created.
          console.error(`[hooks] Failed to prepare setup runner for ${worktreePath}:`, error)
        }
      } else {
        void runHook('setup', worktreePath, repo).then((result) => {
          if (!result.success) {
            console.error(`[hooks] setup hook failed for ${worktreePath}:`, result.output)
          }
        })
      }
    }

    this.notifier?.worktreesChanged(repo.id)
    // Why: the editor currently creates the first Orca-managed terminal as a
    // renderer-side consequence of activating a worktree. CLI-created
    // worktrees must trigger that same activation path or they will exist on
    // disk without becoming the active workspace in the UI.
    this.notifier?.activateWorktree(repo.id, worktree.id, setup)
    this.invalidateResolvedWorktreeCache()
    // Why: the filesystem-auth layer maintains a separate cache of registered
    // worktree roots used by git IPC handlers (branchCompare, diff, status, etc.)
    // to authorize paths. Without invalidating it here, CLI-created worktrees
    // are not recognized and all git operations fail with "Access denied:
    // unknown repository or worktree path".
    invalidateAuthorizedRootsCache()
    return {
      worktree,
      ...(setup ? { setup } : {})
    }
  }

  async updateManagedWorktreeMeta(
    worktreeSelector: string,
    updates: {
      displayName?: string
      linkedIssue?: number | null
      comment?: string
    }
  ) {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    const meta = this.store.setWorktreeMeta(worktree.id, {
      ...(updates.displayName !== undefined ? { displayName: updates.displayName } : {}),
      ...(updates.linkedIssue !== undefined ? { linkedIssue: updates.linkedIssue } : {}),
      ...(updates.comment !== undefined ? { comment: updates.comment } : {})
    })
    // Why: unlike renderer-initiated optimistic updates, CLI callers need an
    // explicit push so the editor refreshes metadata changed outside the UI.
    this.invalidateResolvedWorktreeCache()
    this.notifier?.worktreesChanged(worktree.repoId)
    return mergeWorktree(worktree.repoId, worktree.git, meta)
  }

  async removeManagedWorktree(worktreeSelector: string, force = false): Promise<void> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    const repo = this.store.getRepo(worktree.repoId)
    if (!repo) {
      throw new Error('repo_not_found')
    }
    if (isFolderRepo(repo)) {
      throw new Error('Folder mode does not support deleting worktrees.')
    }

    const hooks = getEffectiveHooks(repo)
    if (hooks?.scripts.archive) {
      const result = await runHook('archive', worktree.path, repo)
      if (!result.success) {
        console.error(`[hooks] archive hook failed for ${worktree.path}:`, result.output)
      }
    }

    try {
      await removeWorktree(repo.path, worktree.path, force)
    } catch (error) {
      if (isOrphanedWorktreeError(error)) {
        await rm(worktree.path, { recursive: true, force: true }).catch(() => {})
        // Why: `git worktree remove` failed, so git's internal worktree tracking
        // (`.git/worktrees/<name>`) is still intact. Without pruning, `git worktree
        // list` continues to show the stale entry and the branch it had checked out
        // remains locked — other worktrees cannot check it out.
        await gitExecFileAsync(['worktree', 'prune'], { cwd: repo.path }).catch(() => {})
        this.store.removeWorktreeMeta(worktree.id)
        this.invalidateResolvedWorktreeCache()
        invalidateAuthorizedRootsCache()
        this.notifier?.worktreesChanged(repo.id)
        return
      }
      throw new Error(formatWorktreeRemovalError(error, worktree.path, force))
    }

    this.store.removeWorktreeMeta(worktree.id)
    this.invalidateResolvedWorktreeCache()
    invalidateAuthorizedRootsCache()
    this.notifier?.worktreesChanged(repo.id)
  }

  async stopTerminalsForWorktree(worktreeSelector: string): Promise<{ stopped: number }> {
    // Why: this mutates live PTYs, so the runtime must reject it while the
    // renderer graph is reloading instead of acting on cached leaf ownership.
    const graphEpoch = this.captureReadyGraphEpoch()
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    this.assertStableReadyGraph(graphEpoch)
    const ptyIds = new Set<string>()
    for (const leaf of this.leaves.values()) {
      if (leaf.worktreeId === worktree.id && leaf.ptyId) {
        ptyIds.add(leaf.ptyId)
      }
    }

    let stopped = 0
    for (const ptyId of ptyIds) {
      if (this.ptyController?.kill(ptyId)) {
        stopped += 1
      }
    }
    return { stopped }
  }

  markRendererReloading(windowId: number): void {
    if (windowId !== this.authoritativeWindowId) {
      return
    }
    if (this.graphStatus !== 'ready') {
      return
    }
    // Why: any renderer reload tears down the published live graph, so live
    // terminal handles must become stale immediately instead of being reused
    // against whatever the renderer rebuilds next.
    this.rendererGraphEpoch += 1
    this.graphStatus = 'reloading'
    this.handles.clear()
    this.handleByLeafKey.clear()
    this.rejectAllWaiters('terminal_handle_stale')
    this.refreshWritableFlags()
  }

  markGraphReady(windowId: number): void {
    if (windowId !== this.authoritativeWindowId) {
      return
    }
    this.graphStatus = 'ready'
    this.refreshWritableFlags()
  }

  markGraphUnavailable(windowId: number): void {
    if (windowId !== this.authoritativeWindowId) {
      return
    }
    // Why: once the authoritative renderer graph disappears, Orca must fail
    // closed for live-terminal operations instead of guessing from old state.
    if (this.graphStatus !== 'unavailable') {
      this.rendererGraphEpoch += 1
    }
    this.graphStatus = 'unavailable'
    this.authoritativeWindowId = null
    this.tabs.clear()
    this.leaves.clear()
    this.handles.clear()
    this.handleByLeafKey.clear()
    this.rejectAllWaiters('terminal_handle_stale')
  }

  private assertGraphReady(): void {
    if (this.graphStatus !== 'ready') {
      throw new Error('runtime_unavailable')
    }
  }

  private captureReadyGraphEpoch(): number {
    this.assertGraphReady()
    return this.rendererGraphEpoch
  }

  private assertStableReadyGraph(expectedGraphEpoch: number): void {
    if (this.graphStatus !== 'ready' || this.rendererGraphEpoch !== expectedGraphEpoch) {
      throw new Error('runtime_unavailable')
    }
  }

  private async resolveWorktreeSelector(selector: string): Promise<ResolvedWorktree> {
    const worktrees = await this.listResolvedWorktrees()
    let candidates: ResolvedWorktree[]

    if (selector === 'active') {
      throw new Error('selector_not_found')
    }

    if (selector.startsWith('id:')) {
      candidates = worktrees.filter((worktree) => worktree.id === selector.slice(3))
    } else if (selector.startsWith('path:')) {
      candidates = worktrees.filter((worktree) => worktree.path === selector.slice(5))
    } else if (selector.startsWith('branch:')) {
      const branchSelector = selector.slice(7)
      candidates = worktrees.filter((worktree) =>
        branchSelectorMatches(worktree.branch, branchSelector)
      )
    } else if (selector.startsWith('issue:')) {
      candidates = worktrees.filter(
        (worktree) =>
          worktree.linkedIssue !== null && String(worktree.linkedIssue) === selector.slice(6)
      )
    } else {
      candidates = worktrees.filter(
        (worktree) =>
          worktree.id === selector ||
          worktree.path === selector ||
          branchSelectorMatches(worktree.branch, selector)
      )
    }

    if (candidates.length === 1) {
      return candidates[0]
    }
    if (candidates.length > 1) {
      throw new Error('selector_ambiguous')
    }
    throw new Error('selector_not_found')
  }

  private async resolveRepoSelector(selector: string): Promise<Repo> {
    if (!this.store) {
      throw new Error('repo_not_found')
    }
    const repos = this.store.getRepos()
    let candidates: Repo[]

    if (selector.startsWith('id:')) {
      candidates = repos.filter((repo) => repo.id === selector.slice(3))
    } else if (selector.startsWith('path:')) {
      candidates = repos.filter((repo) => repo.path === selector.slice(5))
    } else if (selector.startsWith('name:')) {
      candidates = repos.filter((repo) => repo.displayName === selector.slice(5))
    } else {
      candidates = repos.filter(
        (repo) => repo.id === selector || repo.path === selector || repo.displayName === selector
      )
    }

    if (candidates.length === 1) {
      return candidates[0]
    }
    if (candidates.length > 1) {
      throw new Error('selector_ambiguous')
    }
    throw new Error('repo_not_found')
  }

  private async listResolvedWorktrees(): Promise<ResolvedWorktree[]> {
    if (!this.store) {
      return []
    }
    const now = Date.now()
    if (this.resolvedWorktreeCache && this.resolvedWorktreeCache.expiresAt > now) {
      return this.resolvedWorktreeCache.worktrees
    }

    const metaById = this.store.getAllWorktreeMeta()
    const worktrees: ResolvedWorktree[] = []
    for (const repo of this.store.getRepos()) {
      const gitWorktrees = await listRepoWorktrees(repo)
      for (const gitWorktree of gitWorktrees) {
        const worktreeId = `${repo.id}::${gitWorktree.path}`
        const merged = mergeWorktree(repo.id, gitWorktree, metaById[worktreeId], repo.displayName)
        worktrees.push({
          id: merged.id,
          repoId: repo.id,
          path: merged.path,
          branch: merged.branch,
          linkedIssue: metaById[worktreeId]?.linkedIssue ?? null,
          git: {
            path: gitWorktree.path,
            head: gitWorktree.head,
            branch: gitWorktree.branch,
            isBare: gitWorktree.isBare,
            isMainWorktree: gitWorktree.isMainWorktree
          },
          displayName: merged.displayName,
          comment: merged.comment
        })
      }
    }
    // Why: terminal polling can be frequent, but git worktree state is still
    // allowed to change outside Orca. A short TTL avoids shelling out on every
    // read without pretending the cache is authoritative for long.
    this.resolvedWorktreeCache = {
      worktrees,
      expiresAt: now + RESOLVED_WORKTREE_CACHE_TTL_MS
    }
    return worktrees
  }

  private async getResolvedWorktreeMap(): Promise<Map<string, ResolvedWorktree>> {
    return new Map((await this.listResolvedWorktrees()).map((worktree) => [worktree.id, worktree]))
  }

  private invalidateResolvedWorktreeCache(): void {
    this.resolvedWorktreeCache = null
  }

  private buildTerminalSummary(
    leaf: RuntimeLeafRecord,
    worktreesById: Map<string, ResolvedWorktree>
  ): RuntimeTerminalSummary {
    const worktree = worktreesById.get(leaf.worktreeId)
    const tab = this.tabs.get(leaf.tabId) ?? null

    return {
      handle: this.issueHandle(leaf),
      worktreeId: leaf.worktreeId,
      worktreePath: worktree?.path ?? '',
      branch: worktree?.branch ?? '',
      tabId: leaf.tabId,
      leafId: leaf.leafId,
      title: tab?.title ?? null,
      connected: leaf.connected,
      writable: leaf.writable,
      lastOutputAt: leaf.lastOutputAt,
      preview: leaf.preview
    }
  }

  private getLiveLeafForHandle(handle: string): {
    record: TerminalHandleRecord
    leaf: RuntimeLeafRecord
  } {
    this.assertGraphReady()
    const record = this.handles.get(handle)
    if (!record || record.runtimeId !== this.runtimeId) {
      throw new Error('terminal_handle_stale')
    }
    if (record.rendererGraphEpoch !== this.rendererGraphEpoch) {
      throw new Error('terminal_handle_stale')
    }

    const leaf = this.leaves.get(this.getLeafKey(record.tabId, record.leafId))
    if (!leaf || leaf.ptyId !== record.ptyId || leaf.ptyGeneration !== record.ptyGeneration) {
      throw new Error('terminal_handle_stale')
    }
    return { record, leaf }
  }

  private issueHandle(leaf: RuntimeLeafRecord): string {
    const leafKey = this.getLeafKey(leaf.tabId, leaf.leafId)
    const existingHandle = this.handleByLeafKey.get(leafKey)
    if (existingHandle) {
      const existingRecord = this.handles.get(existingHandle)
      if (
        existingRecord &&
        existingRecord.rendererGraphEpoch === this.rendererGraphEpoch &&
        existingRecord.ptyId === leaf.ptyId &&
        existingRecord.ptyGeneration === leaf.ptyGeneration
      ) {
        return existingHandle
      }
    }

    const handle = `term_${randomUUID()}`
    this.handles.set(handle, {
      handle,
      runtimeId: this.runtimeId,
      rendererGraphEpoch: this.rendererGraphEpoch,
      worktreeId: leaf.worktreeId,
      tabId: leaf.tabId,
      leafId: leaf.leafId,
      ptyId: leaf.ptyId,
      ptyGeneration: leaf.ptyGeneration
    })
    this.handleByLeafKey.set(leafKey, handle)
    return handle
  }

  private refreshWritableFlags(): void {
    for (const leaf of this.leaves.values()) {
      leaf.writable = this.graphStatus === 'ready' && leaf.connected && leaf.ptyId !== null
    }
  }

  private invalidateLeafHandle(leafKey: string): void {
    const handle = this.handleByLeafKey.get(leafKey)
    if (!handle) {
      return
    }
    this.handleByLeafKey.delete(leafKey)
    this.handles.delete(handle)
    this.rejectWaitersForHandle(handle, 'terminal_handle_stale')
  }

  private resolveExitWaiters(leaf: RuntimeLeafRecord): void {
    const handle = this.handleByLeafKey.get(this.getLeafKey(leaf.tabId, leaf.leafId))
    if (!handle) {
      return
    }
    const waiters = this.waitersByHandle.get(handle)
    if (!waiters || waiters.size === 0) {
      return
    }
    for (const waiter of [...waiters]) {
      this.resolveWaiter(waiter, buildTerminalWaitResult(handle, leaf))
    }
  }

  private resolveWaiter(waiter: TerminalWaiter, result: RuntimeTerminalWait): void {
    this.removeWaiter(waiter)
    waiter.resolve(result)
  }

  private rejectWaitersForHandle(handle: string, code: string): void {
    const waiters = this.waitersByHandle.get(handle)
    if (!waiters || waiters.size === 0) {
      return
    }
    for (const waiter of [...waiters]) {
      this.removeWaiter(waiter)
      waiter.reject(new Error(code))
    }
  }

  private rejectAllWaiters(code: string): void {
    for (const handle of [...this.waitersByHandle.keys()]) {
      this.rejectWaitersForHandle(handle, code)
    }
  }

  private removeWaiter(waiter: TerminalWaiter): void {
    if (waiter.timeout) {
      clearTimeout(waiter.timeout)
    }
    const waiters = this.waitersByHandle.get(waiter.handle)
    if (!waiters) {
      return
    }
    waiters.delete(waiter)
    if (waiters.size === 0) {
      this.waitersByHandle.delete(waiter.handle)
    }
  }

  private getLeafKey(tabId: string, leafId: string): string {
    return `${tabId}::${leafId}`
  }

  // ── Browser automation ──

  private requireAgentBrowserBridge(): AgentBrowserBridge {
    if (!this.agentBrowserBridge) {
      throw new Error('runtime_unavailable')
    }
    return this.agentBrowserBridge
  }

  // Why: the CLI sends worktree selectors (e.g. "path:/Users/...") but the
  // bridge stores worktreeIds in "repoId::path" format (from the renderer's
  // Zustand store). This helper resolves the selector to the store-compatible
  // ID so the bridge can filter tabs correctly.
  private async resolveBrowserWorktreeId(selector?: string): Promise<string | undefined> {
    if (!selector) {
      // Why: after app restart, webviews only mount when the browser pane is visible.
      // Without --worktree, we still need to activate the view so persisted tabs
      // become operable via registerGuest.
      const bridge = this.agentBrowserBridge
      if (bridge && bridge.getRegisteredTabs().size === 0) {
        const win = this.getAuthoritativeWindow()
        win.webContents.send('browser:activateView', {})
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      return undefined
    }
    try {
      const worktreeId = (await this.resolveWorktreeSelector(selector)).id
      // Why: if the worktree has no registered tabs in the bridge, it's likely
      // not the active worktree in the UI (webviews only mount for the active
      // worktree). Activate it so existing tabs become operable.
      const bridge = this.agentBrowserBridge
      if (bridge && bridge.getRegisteredTabs(worktreeId).size === 0) {
        await this.ensureBrowserWorktreeActive(worktreeId)
      }
      return worktreeId
    } catch {
      return undefined
    }
  }

  // Why: browser tabs only mount (and become operable) when their worktree is
  // the active worktree in the renderer AND activeTabType is 'browser'. If either
  // condition is false, the webview stays in display:none and Electron won't start
  // its guest process — dom-ready never fires, registerGuest never runs, and CLI
  // browser commands fail with "CDP connection refused".
  private async ensureBrowserWorktreeActive(worktreeId: string): Promise<void> {
    const win = this.getAuthoritativeWindow()
    const repoId = worktreeId.split('::')[0]
    if (!repoId) {
      return
    }
    win.webContents.send('ui:activateWorktree', { repoId, worktreeId })
    // Why: switching worktree alone sets activeView='terminal'. Browser webviews
    // won't mount until activeTabType is 'browser'. Send a second IPC to flip it.
    win.webContents.send('browser:activateView', { worktreeId })
    // Why: give the renderer time to mount the webview after switching worktrees.
    // The webview needs to attach and fire dom-ready before registerGuest runs.
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  // Why: agent-browser drives navigation via CDP, which bypasses Electron's
  // webview event system. The renderer's did-navigate / page-title-updated
  // listeners never fire, leaving the Zustand store (and thus the Orca UI's
  // address bar and tab title) stale. Push updates from main → renderer after
  // any navigation-causing command so the UI stays in sync.
  private notifyRendererNavigation(browserPageId: string, url: string, title: string): void {
    try {
      const win = this.getAuthoritativeWindow()
      win.webContents.send('browser:navigation-update', { browserPageId, url, title })
    } catch {
      // Window may not exist during shutdown
    }
  }

  async browserSnapshot(params: { worktree?: string }): Promise<BrowserSnapshotResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().snapshot(worktreeId)
  }

  async browserClick(params: { element: string; worktree?: string }): Promise<BrowserClickResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    const bridge = this.requireAgentBrowserBridge()
    const result = await bridge.click(params.element, worktreeId)
    // Why: clicks can trigger navigation (e.g. submitting a form, clicking a link).
    // Read the live URL/title after the click and push to renderer so the UI updates.
    const pageId = bridge.getActivePageId(worktreeId)
    if (pageId) {
      const tabs = bridge.tabList(worktreeId)
      const active = tabs.tabs.find((t) => t.active)
      if (active) {
        this.notifyRendererNavigation(pageId, active.url, active.title)
      }
    }
    return result
  }

  async browserGoto(params: { url: string; worktree?: string }): Promise<BrowserGotoResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    const bridge = this.requireAgentBrowserBridge()
    const result = await bridge.goto(params.url, worktreeId)
    const pageId = bridge.getActivePageId(worktreeId)
    if (pageId) {
      this.notifyRendererNavigation(pageId, result.url, result.title)
    }
    return result
  }

  async browserFill(params: {
    element: string
    value: string
    worktree?: string
  }): Promise<BrowserFillResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().fill(params.element, params.value, worktreeId)
  }

  async browserType(params: { input: string; worktree?: string }): Promise<BrowserTypeResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().type(params.input, worktreeId)
  }

  async browserSelect(params: {
    element: string
    value: string
    worktree?: string
  }): Promise<BrowserSelectResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().select(params.element, params.value, worktreeId)
  }

  async browserScroll(params: {
    direction: 'up' | 'down'
    amount?: number
    worktree?: string
  }): Promise<BrowserScrollResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().scroll(params.direction, params.amount, worktreeId)
  }

  async browserBack(params: { worktree?: string }): Promise<BrowserBackResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    const bridge = this.requireAgentBrowserBridge()
    const result = await bridge.back(worktreeId)
    const pageId = bridge.getActivePageId(worktreeId)
    if (pageId) {
      this.notifyRendererNavigation(pageId, result.url, result.title)
    }
    return result
  }

  async browserReload(params: { worktree?: string }): Promise<BrowserReloadResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    const bridge = this.requireAgentBrowserBridge()
    const result = await bridge.reload(worktreeId)
    const pageId = bridge.getActivePageId(worktreeId)
    if (pageId) {
      this.notifyRendererNavigation(pageId, result.url, result.title)
    }
    return result
  }

  async browserScreenshot(params: {
    format?: 'png' | 'jpeg'
    worktree?: string
  }): Promise<BrowserScreenshotResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().screenshot(params.format, worktreeId)
  }

  async browserEval(params: { expression: string; worktree?: string }): Promise<BrowserEvalResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().evaluate(params.expression, worktreeId)
  }

  async browserTabList(params: { worktree?: string }): Promise<BrowserTabListResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().tabList(worktreeId)
  }

  async browserTabSwitch(params: {
    index: number
    worktree?: string
  }): Promise<BrowserTabSwitchResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().tabSwitch(params.index, worktreeId)
  }

  async browserHover(params: { element: string; worktree?: string }): Promise<BrowserHoverResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().hover(params.element, worktreeId)
  }

  async browserDrag(params: {
    from: string
    to: string
    worktree?: string
  }): Promise<BrowserDragResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().drag(params.from, params.to, worktreeId)
  }

  async browserUpload(params: {
    element: string
    files: string[]
    worktree?: string
  }): Promise<BrowserUploadResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().upload(params.element, params.files, worktreeId)
  }

  async browserWait(params: {
    selector?: string
    timeout?: number
    text?: string
    url?: string
    load?: string
    fn?: string
    state?: string
    worktree?: string
  }): Promise<BrowserWaitResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    const { worktree: _, ...options } = params
    return this.requireAgentBrowserBridge().wait(options, worktreeId)
  }

  async browserCheck(params: {
    element: string
    checked: boolean
    worktree?: string
  }): Promise<BrowserCheckResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().check(params.element, params.checked, worktreeId)
  }

  async browserFocus(params: { element: string; worktree?: string }): Promise<BrowserFocusResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().focus(params.element, worktreeId)
  }

  async browserClear(params: { element: string; worktree?: string }): Promise<BrowserClearResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().clear(params.element, worktreeId)
  }

  async browserSelectAll(params: {
    element: string
    worktree?: string
  }): Promise<BrowserSelectAllResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().selectAll(params.element, worktreeId)
  }

  async browserKeypress(params: {
    key: string
    worktree?: string
  }): Promise<BrowserKeypressResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().keypress(params.key, worktreeId)
  }

  async browserPdf(params: { worktree?: string }): Promise<BrowserPdfResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().pdf(worktreeId)
  }

  async browserFullScreenshot(params: {
    format?: 'png' | 'jpeg'
    worktree?: string
  }): Promise<BrowserScreenshotResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().fullPageScreenshot(params.format, worktreeId)
  }

  // ── Cookie management ──

  async browserCookieGet(params: {
    url?: string
    worktree?: string
  }): Promise<BrowserCookieGetResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().cookieGet(params.url, worktreeId)
  }

  async browserCookieSet(params: {
    name: string
    value: string
    domain?: string
    path?: string
    secure?: boolean
    httpOnly?: boolean
    sameSite?: string
    expires?: number
    worktree?: string
  }): Promise<BrowserCookieSetResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().cookieSet(params, worktreeId)
  }

  async browserCookieDelete(params: {
    name: string
    domain?: string
    url?: string
    worktree?: string
  }): Promise<BrowserCookieDeleteResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().cookieDelete(
      params.name,
      params.domain,
      params.url,
      worktreeId
    )
  }

  // ── Viewport ──

  async browserSetViewport(params: {
    width: number
    height: number
    deviceScaleFactor?: number
    mobile?: boolean
    worktree?: string
  }): Promise<BrowserViewportResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().setViewport(
      params.width,
      params.height,
      params.deviceScaleFactor,
      params.mobile,
      worktreeId
    )
  }

  // ── Geolocation ──

  async browserSetGeolocation(params: {
    latitude: number
    longitude: number
    accuracy?: number
    worktree?: string
  }): Promise<BrowserGeolocationResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().setGeolocation(
      params.latitude,
      params.longitude,
      params.accuracy,
      worktreeId
    )
  }

  // ── Request interception ──

  async browserInterceptEnable(params: {
    patterns?: string[]
    worktree?: string
  }): Promise<BrowserInterceptEnableResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().interceptEnable(params.patterns, worktreeId)
  }

  async browserInterceptDisable(params: {
    worktree?: string
  }): Promise<BrowserInterceptDisableResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().interceptDisable(worktreeId)
  }

  async browserInterceptList(params: { worktree?: string }): Promise<{ requests: unknown[] }> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().interceptList(worktreeId)
  }

  // ── Console/network capture ──

  async browserCaptureStart(params: { worktree?: string }): Promise<BrowserCaptureStartResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().captureStart(worktreeId)
  }

  async browserCaptureStop(params: { worktree?: string }): Promise<BrowserCaptureStopResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().captureStop(worktreeId)
  }

  async browserConsoleLog(params: {
    limit?: number
    worktree?: string
  }): Promise<BrowserConsoleResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().consoleLog(params.limit, worktreeId)
  }

  async browserNetworkLog(params: {
    limit?: number
    worktree?: string
  }): Promise<BrowserNetworkLogResult> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().networkLog(params.limit, worktreeId)
  }

  // ── Additional core commands ──

  async browserDblclick(params: { element: string; worktree?: string }): Promise<unknown> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().dblclick(params.element, worktreeId)
  }

  async browserForward(params: { worktree?: string }): Promise<unknown> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().forward(worktreeId)
  }

  async browserScrollIntoView(params: { element: string; worktree?: string }): Promise<unknown> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().scrollIntoView(params.element, worktreeId)
  }

  async browserGet(params: {
    what: string
    selector?: string
    worktree?: string
  }): Promise<unknown> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().get(params.what, params.selector, worktreeId)
  }

  async browserIs(params: { what: string; selector: string; worktree?: string }): Promise<unknown> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().is(params.what, params.selector, worktreeId)
  }

  // ── Keyboard insert text ──

  async browserKeyboardInsertText(params: { text: string; worktree?: string }): Promise<unknown> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().keyboardInsertText(params.text, worktreeId)
  }

  // ── Mouse commands ──

  async browserMouseMove(params: { x: number; y: number; worktree?: string }): Promise<unknown> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().mouseMove(params.x, params.y, worktreeId)
  }

  async browserMouseDown(params: { button?: string; worktree?: string }): Promise<unknown> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().mouseDown(params.button, worktreeId)
  }

  async browserMouseUp(params: { button?: string; worktree?: string }): Promise<unknown> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().mouseUp(params.button, worktreeId)
  }

  async browserMouseWheel(params: {
    dy: number
    dx?: number
    worktree?: string
  }): Promise<unknown> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().mouseWheel(params.dy, params.dx, worktreeId)
  }

  // ── Find (semantic locators) ──

  async browserFind(params: {
    locator: string
    value: string
    action: string
    text?: string
    worktree?: string
  }): Promise<unknown> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().find(
      params.locator,
      params.value,
      params.action,
      params.text,
      worktreeId
    )
  }

  // ── Set commands ──

  async browserSetDevice(params: { name: string; worktree?: string }): Promise<unknown> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().setDevice(params.name, worktreeId)
  }

  async browserSetOffline(params: { state?: string; worktree?: string }): Promise<unknown> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().setOffline(params.state, worktreeId)
  }

  async browserSetHeaders(params: { headers: string; worktree?: string }): Promise<unknown> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().setHeaders(params.headers, worktreeId)
  }

  async browserSetCredentials(params: {
    user: string
    pass: string
    worktree?: string
  }): Promise<unknown> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().setCredentials(params.user, params.pass, worktreeId)
  }

  async browserSetMedia(params: {
    colorScheme?: string
    reducedMotion?: string
    worktree?: string
  }): Promise<unknown> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().setMedia(
      params.colorScheme,
      params.reducedMotion,
      worktreeId
    )
  }

  // ── Clipboard commands ──

  async browserClipboardRead(params: { worktree?: string }): Promise<unknown> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().clipboardRead(worktreeId)
  }

  async browserClipboardWrite(params: { text: string; worktree?: string }): Promise<unknown> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().clipboardWrite(params.text, worktreeId)
  }

  // ── Dialog commands ──

  async browserDialogAccept(params: { text?: string; worktree?: string }): Promise<unknown> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().dialogAccept(params.text, worktreeId)
  }

  async browserDialogDismiss(params: { worktree?: string }): Promise<unknown> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().dialogDismiss(worktreeId)
  }

  // ── Storage commands ──

  async browserStorageLocalGet(params: { key: string; worktree?: string }): Promise<unknown> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().storageLocalGet(params.key, worktreeId)
  }

  async browserStorageLocalSet(params: {
    key: string
    value: string
    worktree?: string
  }): Promise<unknown> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().storageLocalSet(params.key, params.value, worktreeId)
  }

  async browserStorageLocalClear(params: { worktree?: string }): Promise<unknown> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().storageLocalClear(worktreeId)
  }

  async browserStorageSessionGet(params: { key: string; worktree?: string }): Promise<unknown> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().storageSessionGet(params.key, worktreeId)
  }

  async browserStorageSessionSet(params: {
    key: string
    value: string
    worktree?: string
  }): Promise<unknown> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().storageSessionSet(params.key, params.value, worktreeId)
  }

  async browserStorageSessionClear(params: { worktree?: string }): Promise<unknown> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().storageSessionClear(worktreeId)
  }

  // ── Download command ──

  async browserDownload(params: {
    selector: string
    path: string
    worktree?: string
  }): Promise<unknown> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().download(params.selector, params.path, worktreeId)
  }

  // ── Highlight command ──

  async browserHighlight(params: { selector: string; worktree?: string }): Promise<unknown> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().highlight(params.selector, worktreeId)
  }

  // ── New: exec passthrough + tab lifecycle ──

  async browserExec(params: { command: string; worktree?: string }): Promise<unknown> {
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)
    return this.requireAgentBrowserBridge().exec(params.command, worktreeId)
  }

  async browserTabCreate(params: {
    url?: string
    worktree?: string
  }): Promise<{ browserPageId: string }> {
    const win = this.getAuthoritativeWindow()
    const requestId = randomUUID()
    const url = params.url ?? 'about:blank'

    // Why: the renderer's Zustand store keys browser tabs by worktreeId in
    // "repoId::path" format. The CLI sends a selector (e.g. "path:/Users/...").
    // Resolve it here so the renderer receives the store-compatible ID.
    const worktreeId = params.worktree
      ? (await this.resolveWorktreeSelector(params.worktree)).id
      : undefined

    // Why: browser webviews only mount when their worktree is active in the UI.
    // Switch to it before creating the tab so the webview attaches immediately.
    if (worktreeId) {
      await this.ensureBrowserWorktreeActive(worktreeId)
    }

    // Why: tab creation is a renderer-side Zustand store operation. The main process
    // sends a request, the renderer creates the tab and replies with the workspace ID
    // (which is the browserPageId used by registerGuest and the bridge).
    const browserPageId = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        ipcMain.removeListener('browser:tabCreateReply', handler)
        reject(new Error('Tab creation timed out'))
      }, 10_000)

      const handler = (
        _event: Electron.IpcMainEvent,
        reply: { requestId: string; browserPageId?: string; error?: string }
      ): void => {
        if (reply.requestId !== requestId) {
          return
        }
        clearTimeout(timer)
        ipcMain.removeListener('browser:tabCreateReply', handler)
        if (reply.error) {
          reject(new Error(reply.error))
        } else {
          resolve(reply.browserPageId!)
        }
      }
      ipcMain.on('browser:tabCreateReply', handler)
      win.webContents.send('browser:requestTabCreate', { requestId, url, worktreeId })
    })

    // Why: the renderer creates the Zustand tab immediately, but the webview must
    // mount and fire dom-ready before registerGuest runs. Waiting here ensures the
    // tab is operable by subsequent CLI commands (snapshot, click, etc.).
    // If registration doesn't complete within timeout, return the ID anyway — the
    // tab exists in the UI but may not be ready for automation commands yet.
    try {
      await waitForTabRegistration(browserPageId)
    } catch {
      // Tab was created in the renderer but the webview hasn't finished mounting.
      // Return success since the tab exists; subsequent commands will fail with a
      // clear "tab not available" error if the webview never loads.
    }

    // Why: newly created tabs should be auto-activated so subsequent commands
    // (snapshot, click, goto) target the new tab without requiring an explicit
    // tab switch. Without this, the bridge's active tab still points at the
    // previously active tab and the new tab shows active: false in tab list.
    const bridge = this.requireAgentBrowserBridge()
    const wcId = bridge.getRegisteredTabs(worktreeId).get(browserPageId)
    if (wcId != null) {
      bridge.setActiveTab(wcId, worktreeId)
    }

    // Why: the renderer sets webview.src=url on mount, but agent-browser connects
    // via CDP after the webview loads about:blank. Without an explicit goto, the
    // page stays blank from agent-browser's perspective. Navigate via the bridge
    // so agent-browser's CDP session tracks the correct page state.
    if (url && url !== 'about:blank') {
      try {
        const result = await bridge.goto(url, worktreeId)
        this.notifyRendererNavigation(browserPageId, result.url, result.title)
      } catch {
        // Tab exists but navigation failed — caller can retry with explicit goto
      }
    }

    return { browserPageId }
  }

  async browserTabClose(params: {
    index?: number
    worktree?: string
  }): Promise<{ closed: boolean }> {
    const win = this.getAuthoritativeWindow()
    const bridge = this.requireAgentBrowserBridge()
    const worktreeId = await this.resolveBrowserWorktreeId(params.worktree)

    let tabId: string | null = null
    if (params.index !== undefined) {
      const tabs = bridge.getRegisteredTabs(worktreeId)
      const entries = [...tabs.entries()]
      if (params.index < 0 || params.index >= entries.length) {
        throw new Error(`Tab index ${params.index} out of range (0-${entries.length - 1})`)
      }
      tabId = entries[params.index][0]
    } else {
      // Why: try the bridge first (registered tabs with webviews), then fall back
      // to asking the renderer to close its active browser tab (handles cases where
      // the webview hasn't mounted yet, e.g. tab was just created).
      const tabs = bridge.getRegisteredTabs(worktreeId)
      const entries = [...tabs.entries()]
      const activeEntry = entries.find(([, wcId]) => wcId === bridge.getActiveWebContentsId())
      if (activeEntry) {
        tabId = activeEntry[0]
      }
    }

    const requestId = randomUUID()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ipcMain.removeListener('browser:tabCloseReply', handler)
        reject(new Error('Tab close timed out'))
      }, 10_000)

      const handler = (
        _event: Electron.IpcMainEvent,
        reply: { requestId: string; error?: string }
      ): void => {
        if (reply.requestId !== requestId) {
          return
        }
        clearTimeout(timer)
        ipcMain.removeListener('browser:tabCloseReply', handler)
        if (reply.error) {
          reject(new Error(reply.error))
        } else {
          resolve()
        }
      }
      ipcMain.on('browser:tabCloseReply', handler)
      win.webContents.send('browser:requestTabClose', { requestId, tabId })
    })

    return { closed: true }
  }

  private getAuthoritativeWindow(): BrowserWindow {
    if (this.authoritativeWindowId === null) {
      throw new Error('No renderer window available')
    }
    const win = BrowserWindow.fromId(this.authoritativeWindowId)
    if (!win || win.isDestroyed()) {
      throw new Error('No renderer window available')
    }
    return win
  }
}

const MAX_TAIL_LINES = 120
const MAX_TAIL_CHARS = 4000
const MAX_PREVIEW_LINES = 6
const MAX_PREVIEW_CHARS = 300
const DEFAULT_REPO_SEARCH_REFS_LIMIT = 25
const DEFAULT_TERMINAL_LIST_LIMIT = 200
const DEFAULT_WORKTREE_LIST_LIMIT = 200
const DEFAULT_WORKTREE_PS_LIMIT = 200
const RESOLVED_WORKTREE_CACHE_TTL_MS = 1000
function buildPreview(lines: string[], partialLine: string): string {
  const previewLines = buildTailLines(lines, partialLine)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-MAX_PREVIEW_LINES)
  const preview = previewLines.join('\n')
  return preview.length > MAX_PREVIEW_CHARS
    ? preview.slice(preview.length - MAX_PREVIEW_CHARS)
    : preview
}

function appendToTailBuffer(
  previousLines: string[],
  previousPartialLine: string,
  chunk: string
): {
  lines: string[]
  partialLine: string
  truncated: boolean
} {
  const normalizedChunk = normalizeTerminalChunk(chunk)
  if (normalizedChunk.length === 0) {
    return {
      lines: previousLines,
      partialLine: previousPartialLine,
      truncated: false
    }
  }

  const pieces = `${previousPartialLine}${normalizedChunk}`.split('\n')
  const nextPartialLine = (pieces.pop() ?? '').replace(/[ \t]+$/g, '')
  const nextLines = [...previousLines, ...pieces.map((line) => line.replace(/[ \t]+$/g, ''))]
  let truncated = false

  while (nextLines.length > MAX_TAIL_LINES) {
    nextLines.shift()
    truncated = true
  }

  let totalChars = nextLines.reduce((sum, line) => sum + line.length, 0) + nextPartialLine.length
  while (nextLines.length > 0 && totalChars > MAX_TAIL_CHARS) {
    totalChars -= nextLines.shift()!.length
    truncated = true
  }

  return {
    lines: nextLines,
    partialLine: nextPartialLine.slice(-MAX_TAIL_CHARS),
    truncated
  }
}

function buildTailLines(lines: string[], partialLine: string): string[] {
  return partialLine.length > 0 ? [...lines, partialLine] : lines
}

function getTerminalState(leaf: RuntimeLeafRecord): RuntimeTerminalState {
  if (leaf.connected) {
    return 'running'
  }
  if (leaf.lastExitCode !== null) {
    return 'exited'
  }
  return 'unknown'
}

function buildSendPayload(action: {
  text?: string
  enter?: boolean
  interrupt?: boolean
}): string | null {
  let payload = ''
  if (typeof action.text === 'string' && action.text.length > 0) {
    payload += action.text
  }
  if (action.enter) {
    payload += '\r'
  }
  if (action.interrupt) {
    payload += '\x03'
  }
  return payload.length > 0 ? payload : null
}

function buildTerminalWaitResult(handle: string, leaf: RuntimeLeafRecord): RuntimeTerminalWait {
  return {
    handle,
    condition: 'exit',
    satisfied: true,
    status: getTerminalState(leaf),
    exitCode: leaf.lastExitCode
  }
}

function branchSelectorMatches(branch: string, selector: string): boolean {
  // Why: Git worktree data can report local branches as either `refs/heads/foo`
  // or `foo` depending on which plumbing path produced the record. Orca's
  // branch selectors should accept either form so newly created worktrees stay
  // discoverable without exposing internal ref-shape differences to users.
  return normalizeBranchRef(branch) === normalizeBranchRef(selector)
}

function normalizeBranchRef(branch: string): string {
  return branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : branch
}

function normalizeTerminalChunk(chunk: string): string {
  return chunk
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/\u0008/g, '')
    .replace(/[^\x09\x0a\x20-\x7e]/g, '')
}

function maxTimestamp(left: number | null, right: number | null): number | null {
  if (left === null) {
    return right
  }
  if (right === null) {
    return left
  }
  return Math.max(left, right)
}

function compareWorktreePs(
  left: RuntimeWorktreePsSummary,
  right: RuntimeWorktreePsSummary
): number {
  const leftLast = left.lastOutputAt ?? -1
  const rightLast = right.lastOutputAt ?? -1
  if (leftLast !== rightLast) {
    return rightLast - leftLast
  }
  if (left.liveTerminalCount !== right.liveTerminalCount) {
    return right.liveTerminalCount - left.liveTerminalCount
  }
  return left.path.localeCompare(right.path)
}
