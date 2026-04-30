/**
 * Resolve the local branch of a worktree to the PR whose remote head it tracks.
 *
 * Why a dedicated module: `gh pr list --head` filters by `headRefName` (the
 * remote branch name), but the renderer only knows the worktree's local branch
 * name. When the user pushes with an explicit refspec
 * (e.g. `git push origin HEAD:prefix/my-branch`) or configures a remote-branch
 * namespace via `push.autoSetupRemote` + `user.pushDefault`, local and remote
 * names diverge and a naive `--head <localBranch>` query silently returns `[]`.
 *
 * This resolver runs a two-stage cascade with validation:
 *   1. Resolve `<localBranch>@{upstream}` and look up by the remote name. Covers
 *      the common case where upstream is configured (git push -u, autoSetupRemote).
 *   2. Read HEAD's SHA and search PRs by commit. Covers the case where the user
 *      pushed with an explicit refspec and left `branch.<name>.merge` unset, so
 *      `@{upstream}` errors. To avoid matching an unrelated PR that merely
 *      contains our commit in history, we require `candidate.headRefOid === headSha`.
 *
 * If both stages fail we return `null`, matching the pre-fix failure mode.
 */
import type { PRInfo, PRMergeableState } from '../../shared/types'
import { getPRConflictSummary } from './conflict-summary'
import { gitExecFileAsync } from '../git/runner'
import { ghExecFileAsync, acquire, release, getOwnerRepo, type OwnerRepo } from './gh-utils'
import { mapPRState, deriveCheckStatus } from './mappers'

const PR_JSON_FIELDS =
  'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,baseRefName,headRefName,baseRefOid,headRefOid'

type RawPR = {
  number: number
  title: string
  state: string
  url: string
  statusCheckRollup: unknown[]
  updatedAt: string
  isDraft?: boolean
  mergeable: string
  baseRefName?: string
  headRefName?: string
  baseRefOid?: string
  headRefOid?: string
}

/**
 * Resolve a worktree's local branch to its PR on GitHub, if one exists.
 *
 * Returns `null` when no PR matches, when the remote isn't a resolvable GitHub
 * repo, during a rebase (empty branch), or when both stages fail transiently.
 */
export async function resolvePRForBranch(repoPath: string, branch: string): Promise<PRInfo | null> {
  // Why: strip refs/heads/ prefix so the resolver accepts both the symbolic
  // full-name ("refs/heads/foo") and plain form ("foo").
  const localBranch = branch.replace(/^refs\/heads\//, '')

  // Why: during a rebase the worktree is in detached HEAD with no branch
  // name. An empty --head filter causes gh to return an arbitrary PR — bail
  // early. Same guard lived at the call site before the resolver existed.
  if (!localBranch) {
    return null
  }

  const ownerRepo = await getOwnerRepo(repoPath)

  if (!ownerRepo) {
    // Why: the remote isn't a recognizable GitHub URL. Preserve pre-resolver
    // behavior by trying `gh pr view <branch>`, which lets gh resolve the
    // argument via its own tracking-ref inference. Not subject to the same
    // local/remote name mismatch because it doesn't filter by headRefName.
    const stage3 = await lookupByGhPrView(repoPath, localBranch)
    if (stage3) {
      console.debug(`[pr-for-branch] result=found stage=gh-pr-view pr=#${stage3.number}`)
      return await enrichWithConflictSummary(repoPath, stage3)
    }
    console.debug('[pr-for-branch] result=null reason=no-match stage=gh-pr-view')
    return null
  }

  const stage1 = await lookupByUpstreamName(repoPath, localBranch, ownerRepo)
  if (stage1) {
    console.debug(`[pr-for-branch] result=found stage=upstream-name pr=#${stage1.number}`)
    return await enrichWithConflictSummary(repoPath, stage1)
  }

  const stage2 = await lookupBySha(repoPath, ownerRepo)
  if (stage2) {
    console.debug(`[pr-for-branch] result=found stage=sha-fallback pr=#${stage2.number}`)
    return await enrichWithConflictSummary(repoPath, stage2)
  }

  console.debug('[pr-for-branch] result=null reason=no-match')
  return null
}

/**
 * Stage 1 — resolve `<localBranch>@{upstream}` and query gh by the remote
 * branch name. Returns the raw PR or null if upstream is unresolvable, points
 * at an unexpected ref form, or gh returns no match / errors transiently.
 */
async function lookupByUpstreamName(
  repoPath: string,
  localBranch: string,
  ownerRepo: OwnerRepo
): Promise<RawPR | null> {
  let remoteName: string
  try {
    const { stdout } = await gitExecFileAsync(
      ['rev-parse', '--symbolic-full-name', `${localBranch}@{upstream}`],
      { cwd: repoPath }
    )
    // Why: upstream output is "refs/remotes/<remote>/<branch>". Git disallows
    // "/" in remote names, so [^/]+ matches the remote segment exactly no
    // matter what the user named it. A match we can't parse (e.g. upstream
    // pointing at refs/heads/main) falls through to stage 2.
    const match = stdout.trim().match(/^refs\/remotes\/[^/]+\/(.+)$/)
    if (!match) {
      console.debug(
        `[pr-for-branch] stage=upstream-name skip reason=non-remote-upstream value=${stdout.trim()}`
      )
      return null
    }
    remoteName = match[1]
  } catch {
    // Why: no upstream configured (e.g. user pushed with an explicit refspec
    // and without -u). Fall through — stage 2 works without upstream info.
    console.debug('[pr-for-branch] stage=upstream-name skip reason=no-upstream')
    return null
  }

  console.debug(
    `[pr-for-branch] stage=upstream-name localBranch=${localBranch} remoteName=${remoteName}`
  )

  await acquire()
  try {
    const { stdout } = await ghExecFileAsync(
      [
        'pr',
        'list',
        '--repo',
        `${ownerRepo.owner}/${ownerRepo.repo}`,
        '--head',
        remoteName,
        '--state',
        'all',
        '--limit',
        '1',
        '--json',
        PR_JSON_FIELDS
      ],
      { cwd: repoPath }
    )
    const list = JSON.parse(stdout) as RawPR[]
    // Why: --head is already a headRefName filter scoped to the repo we
    // derived from origin, so any match is by definition the PR whose remote
    // branch is this worktree's upstream. No extra validation required.
    return list[0] ?? null
  } catch {
    // Why: transient gh failure (auth, network, rate-limit) should not
    // short-circuit the cascade — stage 2 may still succeed offline of the
    // search index.
    return null
  } finally {
    release()
  }
}

/**
 * Stage 2 — read HEAD's SHA and search by commit. Validates
 * `candidate.headRefOid === headSha` so a PR that merely *contains* our
 * commit in history (rebase-merge, recycled branches) doesn't masquerade as
 * the one we're looking for.
 */
async function lookupBySha(repoPath: string, ownerRepo: OwnerRepo): Promise<RawPR | null> {
  let headSha: string
  try {
    const { stdout } = await gitExecFileAsync(['rev-parse', 'HEAD'], { cwd: repoPath })
    headSha = stdout.trim()
    if (!headSha) {
      return null
    }
  } catch {
    return null
  }

  console.debug(`[pr-for-branch] stage=sha-fallback headSha=${headSha.slice(0, 7)}`)

  await acquire()
  try {
    const { stdout } = await ghExecFileAsync(
      [
        'pr',
        'list',
        '--repo',
        `${ownerRepo.owner}/${ownerRepo.repo}`,
        '--search',
        `${headSha} is:pr`,
        '--state',
        'all',
        // Why: gh's default page size is 30. `--search "<sha> is:pr"` can
        // match any PR whose history contains <sha> — in long-lived repos
        // that's more than 30 for shared base commits. Raise the cap so
        // the headRefOid === headSha candidate isn't silently paged out.
        '--limit',
        '100',
        '--json',
        PR_JSON_FIELDS
      ],
      { cwd: repoPath }
    )
    const list = JSON.parse(stdout) as RawPR[]
    // Why: `gh pr list --search "<sha> is:pr"` returns any PR whose commit
    // history contains <sha>, which is *not* the same question as "is <sha>
    // the PR's tip". Require equality to headRefOid to guard against
    // recycled-branch and merge-commit false positives.
    const match = list.find((pr) => pr.headRefOid === headSha)
    return match ?? null
  } catch {
    return null
  } finally {
    release()
  }
}

/**
 * Fallback for non-GitHub remotes: let gh's own branch inference resolve the
 * PR. Preserves pre-resolver behavior for users whose remote URL doesn't
 * parse as a github.com URL (e.g. SAML-SSO enterprise hosts, self-hosted).
 *
 * Why returns RawPR instead of enriched PRInfo: symmetric with stages 1 and 2
 * — acquire() throttles gh, not git, so the caller must release the lock
 * before invoking enrichWithConflictSummary (which can do a `git fetch` with
 * a 10s timeout). Holding the gh lock across a git-only call would
 * needlessly serialize unrelated gh requests. See docs/pr-for-branch-upstream-resolution.md
 * §"Performance".
 */
async function lookupByGhPrView(repoPath: string, branchName: string): Promise<RawPR | null> {
  await acquire()
  try {
    const { stdout } = await ghExecFileAsync(['pr', 'view', branchName, '--json', PR_JSON_FIELDS], {
      cwd: repoPath
    })
    const raw = JSON.parse(stdout) as RawPR
    return raw ?? null
  } catch {
    return null
  } finally {
    release()
  }
}

async function enrichWithConflictSummary(repoPath: string, data: RawPR): Promise<PRInfo> {
  const conflictSummary =
    data.mergeable === 'CONFLICTING' && data.baseRefName && data.baseRefOid && data.headRefOid
      ? await getPRConflictSummary(repoPath, data.baseRefName, data.baseRefOid, data.headRefOid)
      : undefined

  return {
    number: data.number,
    title: data.title,
    state: mapPRState(data.state, data.isDraft),
    url: data.url,
    checksStatus: deriveCheckStatus(data.statusCheckRollup),
    updatedAt: data.updatedAt,
    mergeable: (data.mergeable as PRMergeableState) ?? 'UNKNOWN',
    headSha: data.headRefOid,
    conflictSummary
  }
}
