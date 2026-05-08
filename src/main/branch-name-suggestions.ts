import { basename, win32 } from 'path'
import type { Store } from './persistence'
import type { BranchNameSuggestionState, WorktreeMeta } from '../shared/types'
import { isFolderRepo } from '../shared/repo-kind'
import { gitExecFileAsync } from './git/runner'
import { getBranchConflictKind } from './git/repo'
import { parseWorktreeId } from './ipc/worktree-logic'
import {
  buildAgentInput,
  buildPrompt,
  extractSlug,
  isSupportedNamingAgent,
  runAgent
} from './branch-name-suggestion-agent'

type SuggestionResult =
  | { ok: true; repoId: string }
  | { ok: false; repoId?: string; reason: string }

const inFlightWorktreeIds = new Set<string>()

function normalizeBranchRef(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

function branchLeaf(branch: string): string {
  return normalizeBranchRef(branch).split('/').at(-1) ?? branch
}

function pathLeaf(pathValue: string): string {
  const platformLeaf = basename(pathValue)
  return platformLeaf === pathValue && /^[A-Za-z]:[\\/]/.test(pathValue)
    ? win32.basename(pathValue)
    : platformLeaf
}

function shouldRenameDisplayName(args: {
  displayName: string | undefined
  worktreePath: string
  originalBranch: string
}): boolean {
  const displayName = args.displayName?.trim()
  if (!displayName) {
    return false
  }
  return (
    displayName === normalizeBranchRef(args.originalBranch) ||
    displayName === branchLeaf(args.originalBranch) ||
    displayName === pathLeaf(args.worktreePath)
  )
}

function nowState(
  current: BranchNameSuggestionState,
  updates: Partial<BranchNameSuggestionState>
): BranchNameSuggestionState {
  return { ...current, ...updates, updatedAt: Date.now() }
}

function markSuggestion(
  store: Store,
  worktreeId: string,
  current: BranchNameSuggestionState,
  updates: Partial<BranchNameSuggestionState>
): WorktreeMeta {
  return store.setWorktreeMeta(worktreeId, {
    branchNameSuggestion: nowState(current, updates)
  })
}

async function gitStdout(args: string[], cwd: string): Promise<string> {
  const { stdout } = await gitExecFileAsync(args, { cwd })
  return stdout.trim()
}

async function currentBranch(worktreePath: string): Promise<string> {
  return gitStdout(['branch', '--show-current'], worktreePath)
}

async function getUpstream(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
      { cwd: worktreePath }
    )
    return stdout.trim() || null
  } catch {
    return null
  }
}

function isBlockingUpstream(upstream: string | null, baseRef: string): boolean {
  return !!upstream && upstream !== baseRef
}

async function remoteBranchExists(worktreePath: string, branchName: string): Promise<boolean> {
  try {
    const stdout = await gitStdout(
      ['for-each-ref', '--format=%(refname)', 'refs/remotes'],
      worktreePath
    )
    return stdout.split('\n').some((ref) => ref.trim().split('/').slice(3).join('/') === branchName)
  } catch {
    return false
  }
}

async function commitCountSinceBase(worktreePath: string, baseRef: string): Promise<number> {
  const stdout = await gitStdout(['rev-list', '--count', `${baseRef}..HEAD`], worktreePath)
  const count = Number.parseInt(stdout, 10)
  return Number.isFinite(count) ? count : 0
}

async function validateCandidate(worktreePath: string, branchName: string): Promise<boolean> {
  try {
    await gitExecFileAsync(['check-ref-format', '--branch', branchName], { cwd: worktreePath })
  } catch {
    return false
  }
  return (await getBranchConflictKind(worktreePath, branchName)) === null
}

async function uniqueBranchName(
  worktreePath: string,
  currentBranchName: string,
  leafSlug: string
): Promise<string> {
  const slashIdx = currentBranchName.lastIndexOf('/')
  const prefix = slashIdx >= 0 ? currentBranchName.slice(0, slashIdx + 1) : ''
  for (let suffix = 1; suffix <= 100; suffix += 1) {
    const leaf = suffix === 1 ? leafSlug : `${leafSlug}-${suffix}`
    const branchName = `${prefix}${leaf}`
    if (branchName === currentBranchName) {
      continue
    }
    if (await validateCandidate(worktreePath, branchName)) {
      return branchName
    }
  }
  throw new Error('no available branch name found')
}

export async function maybeSuggestBranchNameAfterAgentDone(args: {
  store: Store
  worktreeId?: string
  agentType?: string
  onWorktreesChanged: (repoId: string) => void
}): Promise<SuggestionResult> {
  if (!args.worktreeId || !args.store.getSettings().experimentalBranchNameSuggestions) {
    return { ok: false, reason: 'disabled' }
  }
  if (inFlightWorktreeIds.has(args.worktreeId)) {
    return { ok: false, reason: 'in-flight' }
  }
  if (!isSupportedNamingAgent(args.agentType)) {
    return { ok: false, reason: 'unsupported-agent' }
  }

  const { repoId, worktreePath } = parseWorktreeId(args.worktreeId)
  const repo = args.store.getRepo(repoId)
  if (!repo || isFolderRepo(repo) || repo.connectionId) {
    return { ok: false, repoId, reason: 'unsupported-repo' }
  }
  const suggestion = args.store.getWorktreeMeta(args.worktreeId)?.branchNameSuggestion
  if (!suggestion || suggestion.status !== 'idle') {
    return { ok: false, repoId, reason: 'not-eligible' }
  }

  inFlightWorktreeIds.add(args.worktreeId)
  try {
    const branch = await currentBranch(worktreePath)
    if (!branch || branch !== normalizeBranchRef(suggestion.originalBranch)) {
      markSuggestion(args.store, args.worktreeId, suggestion, {
        status: 'skipped',
        failureReason: 'branch changed before suggestion'
      })
      args.onWorktreesChanged(repoId)
      return { ok: false, repoId, reason: 'branch-changed' }
    }
    const upstream = await getUpstream(worktreePath)
    if (
      isBlockingUpstream(upstream, suggestion.baseRef) ||
      (await remoteBranchExists(worktreePath, branch))
    ) {
      markSuggestion(args.store, args.worktreeId, suggestion, {
        status: 'skipped',
        failureReason: 'branch already has a remote'
      })
      args.onWorktreesChanged(repoId)
      return { ok: false, repoId, reason: 'already-pushed' }
    }
    if ((await commitCountSinceBase(worktreePath, suggestion.baseRef)) <= 0) {
      return { ok: false, repoId, reason: 'no-commits' }
    }

    const input = await buildAgentInput(worktreePath, suggestion.baseRef)
    const output = await runAgent(args.agentType, buildPrompt(branch), input, worktreePath)
    const leafSlug = extractSlug(output)
    const suggestedBranch = await uniqueBranchName(worktreePath, branch, leafSlug)
    markSuggestion(args.store, args.worktreeId, suggestion, {
      status: 'suggested',
      suggestedBranch,
      agentType: args.agentType,
      failureReason: undefined
    })
    args.onWorktreesChanged(repoId)
    return { ok: true, repoId }
  } catch (error) {
    markSuggestion(args.store, args.worktreeId, suggestion, {
      status: 'failed',
      agentType: args.agentType,
      failureReason: error instanceof Error ? error.message : String(error)
    })
    args.onWorktreesChanged(repoId)
    return {
      ok: false,
      repoId,
      reason: error instanceof Error ? error.message : String(error)
    }
  } finally {
    inFlightWorktreeIds.delete(args.worktreeId)
  }
}

export async function applyBranchNameSuggestion(args: {
  store: Store
  worktreeId: string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { worktreePath } = parseWorktreeId(args.worktreeId)
  const meta = args.store.getWorktreeMeta(args.worktreeId)
  const suggestion = meta?.branchNameSuggestion
  if (!suggestion || suggestion.status !== 'suggested' || !suggestion.suggestedBranch) {
    return { ok: false, error: 'No branch name suggestion is ready.' }
  }
  const branch = await currentBranch(worktreePath)
  if (branch !== normalizeBranchRef(suggestion.originalBranch)) {
    markSuggestion(args.store, args.worktreeId, suggestion, {
      status: 'skipped',
      failureReason: 'branch changed before apply'
    })
    return { ok: false, error: 'The branch changed before the suggestion could be applied.' }
  }
  if (!(await validateCandidate(worktreePath, suggestion.suggestedBranch))) {
    markSuggestion(args.store, args.worktreeId, suggestion, {
      status: 'failed',
      failureReason: 'suggested branch now conflicts'
    })
    return { ok: false, error: 'The suggested branch name now conflicts with another branch.' }
  }
  await gitExecFileAsync(['branch', '-m', branch, suggestion.suggestedBranch], {
    cwd: worktreePath
  })

  const updatedSuggestion = nowState(suggestion, {
    status: 'applied',
    appliedAt: Date.now()
  })
  args.store.setWorktreeMeta(args.worktreeId, {
    branchNameSuggestion: updatedSuggestion,
    ...(shouldRenameDisplayName({
      displayName: meta?.displayName,
      worktreePath,
      originalBranch: suggestion.originalBranch
    })
      ? { displayName: branchLeaf(suggestion.suggestedBranch) }
      : {})
  })
  return { ok: true }
}

export function dismissBranchNameSuggestion(args: { store: Store; worktreeId: string }): void {
  const suggestion = args.store.getWorktreeMeta(args.worktreeId)?.branchNameSuggestion
  if (!suggestion || suggestion.status !== 'suggested') {
    return
  }
  markSuggestion(args.store, args.worktreeId, suggestion, { status: 'dismissed' })
}
