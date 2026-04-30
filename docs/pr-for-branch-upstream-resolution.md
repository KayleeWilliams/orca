# PR discovery: resolve the branch-to-PR mapping before we give up

## The bug

Orca's "PR for this worktree" indicator silently shows nothing when
a worktree's **local** branch name differs from the **remote** branch
name it tracks.

Concrete repro observed in workspace `node-pty-ci-failure`:

- Local branch: `fix-pr-check-node-gyp-perms`
- Remote branch (on `origin`): `brennanb2025/fix-pr-check-node-gyp-perms`
- Open PR on GitHub: #733, `headRefName = brennanb2025/fix-pr-check-node-gyp-perms`

Orca shows "no PR". `gh pr list --head fix-pr-check-node-gyp-perms`
returns `[]`; `gh pr list --head brennanb2025/fix-pr-check-node-gyp-perms`
returns PR #733.

This happens whenever a user pushes with an explicit refspec, e.g.
`git push origin HEAD:brennanb2025/my-branch`, or configures
`push.autoSetupRemote = true` together with a `user.pushDefault` that
namespaces their remote branches. It is not a rare configuration — it
is common for contributors who namespace remote branches by username.

## Root cause

`getPRForBranch` in `src/main/github/client.ts:745` passes the branch
string it receives from the renderer straight to
`gh pr list --head <branch>`. The renderer computes that string from
the worktree's local `HEAD` (see `fetchPRForBranch` in
`src/renderer/src/store/slices/github.ts:386`), so the value is always
the **local** branch name.

`gh pr list --head` filters by `headRefName`, which is the **remote**
branch name. GitHub has no concept of a local branch, so when the two
names disagree the filter matches nothing and Orca concludes no PR
exists.

The existing fallback path (`gh pr view <branch>`) hits the same
problem for a different reason: `gh pr view` resolves an argument by
first trying it as a PR number, then as a URL, then as a **remote
branch name**. A local-only name fails here too.

### What about the user's upstream config?

One natural fix is to read `@{upstream}` and pass the remote branch
name to `gh`. That works for branches created with `git push -u`
or under `push.autoSetupRemote = true`, because both paths write
`branch.<name>.merge` in `.git/config`.

It does **not** work for the motivating repro. The user ran
`git push origin HEAD:brennanb2025/fix-pr-check-node-gyp-perms`
without `-u` and without `push.autoSetupRemote` enabled. That form
pushes the commits but leaves `branch.<name>.merge` unset, so
`@{upstream}` errors and upstream-name resolution falls back to the
local name — the same name that doesn't match anything on GitHub. The
bug stays broken.

Upstream resolution is still useful (it correctly handles the common
`git push -u` case), but it is not sufficient on its own. We need a
second stage that doesn't depend on local git config.

## The fix: a two-stage resolver with validation

Resolve the branch → PR mapping with a short cascade. Each stage
produces a candidate; we accept it only if it passes a validation
check for the current worktree. If no stage produces a validated
candidate, return `null`.

### Stage 1 — upstream-aware name lookup

Resolve the local branch's upstream:

```ts
// e.g. "refs/remotes/origin/brennanb2025/fix-pr-check-node-gyp-perms"
const { stdout } = await gitExecFileAsync(
  ['rev-parse', '--symbolic-full-name', `${localBranch}@{upstream}`],
  { cwd: repoPath }
)
// Strip "refs/remotes/<remote>/" — the first two segments.
const m = stdout.trim().match(/^refs\/remotes\/[^/]+\/(.+)$/)
const remoteName = m ? m[1] : localBranch
```

Git disallows `/` in remote names, so `[^/]+` safely matches exactly the
remote segment regardless of what the user named the remote.

Pass `remoteName` to `gh pr list --repo O/R --head <remoteName>`. If
a PR comes back, we accept it without further validation: `--head` is
already a `headRefName` filter scoped to the repo we derived from
`origin`, so a match is by definition the PR whose remote branch is
this worktree's upstream.

If `@{upstream}` errors (no upstream configured — e.g. the user
pushed with an explicit refspec, or never pushed), or if it points at
something that isn't a `refs/remotes/*` ref, fall through to stage 2.
A `gh` error in stage 1 (auth, network, rate-limit) also falls
through: we'd rather try the SHA path than return `null` on a
transient failure.

### Stage 2 — HEAD-SHA fallback

Read the worktree's HEAD SHA and search PRs by commit:

```ts
const { stdout: headShaOut } = await gitExecFileAsync(
  ['rev-parse', 'HEAD'],
  { cwd: repoPath }
)
const headSha = headShaOut.trim()

// gh pr list --search "<sha> is:pr" --state all --repo O/R --json ...
```

`gh pr list --search "<sha> is:pr"` returns any PR whose commit
history contains `<sha>`, which is **not** the same question as "is
`<sha>` the PR's tip". To avoid matching an unrelated PR that merely
contains our commit (easy to trigger with closed/merged PRs whose
branch name was later recycled), require
`candidate.headRefOid === headSha` before accepting. If none of the
candidates match, return `null`.

This stage fixes the motivating repro (no upstream config, but the
local HEAD is the same commit as the PR's head) and, as a side
benefit, works during a rebase when HEAD is detached on the same
commit the PR tip points to.

Stage 2 errors (gh exits non-zero, malformed JSON, git rev-parse
fails) are caught and returned as `null`. One stage's error never
short-circuits the other: stage 1 always falls through on any error,
stage 2's result is terminal.

### Why stop at two stages

Superset's cascade (see Prior art) has a third stage — `gh pr view`
with no argument, which relies on gh's own tracking-ref inference.
It is more forgiving but also more dangerous: gh can latch onto a
stale `refs/pull/N/head` from a prior `gh pr checkout` and return
an unrelated PR. Accepting its output requires a separate validation
step (compare `headRepositoryOwner.login` and re-check the ref). For
Orca's motivating cases the two stages above are enough. If telemetry
later shows unresolved-PR reports that stage 1+2 can't handle, we can
add a validated `gh pr view` stage without reshaping the resolver.

### Prior art

Superset's `pr-resolution.ts` implements the same general shape: try
a name-based lookup, then search by SHA, and validate each candidate
against the local branch (`prMatchesLocalBranch`,
`shouldAcceptPRMatch`). Their third `gh pr view` stage adds coverage
for fork branches at the cost of stale-ref handling. We adopt the
cascade-with-validation pattern and the SHA-head equality check, and
skip the third stage for now. emdash's naive `headRefName == localBranch`
equality and warp's single-shot `gh pr view` fall into the same silent-
failure class as Orca's current code, so neither is a useful reference.

## Module layout

Inline resolution belongs in its own file. `client.ts` is already at
1380 lines under `eslint-disable max-lines`, and the codebase pattern
for multi-step gh/git derivations is a dedicated side-file (see
`src/main/github/conflict-summary.ts`).

- **New file:** `src/main/github/branch-pr-resolution.ts`
  - Exports `resolvePRForBranch(repoPath, localBranch): Promise<PRInfo | null>`.
  - Owns stage 1 (upstream → name lookup), stage 2 (SHA fallback),
    the validation predicates, and the debug logging.
  - Imports the gh/git runners from `../git/runner` and the shared
    gh helpers (`getOwnerRepo`, `acquire`/`release`) from
    `./gh-utils`.
- **Thin shim in `client.ts`:** `getPRForBranch` becomes a one-liner
  that delegates to `resolvePRForBranch`. The public signature,
  IPC surface, and renderer contract do not change.
- **New test file:** `src/main/github/branch-pr-resolution.test.ts`
  covers the cascade exhaustively. `client.test.ts` keeps only a
  boundary test that mocks the resolver and verifies wiring.

## Validation rules

Candidates from each stage must clear these checks before we return
them:

1. **Stage 1 (name lookup).** `gh pr list --repo O/R --head <remoteName>`
   already answers the question we're asking; any non-empty result is
   valid. We keep the existing `--state all --limit 1` to match
   today's behavior.
2. **Stage 2 (SHA fallback).** Require
   `candidate.headRefOid === headSha`. This guards against:
   - PRs that merely contain our commit in history (common for
     merge-commit workflows and long-lived feature branches).
   - Recycled branch names that resurface a stale closed/merged PR
     whose HEAD diverged long ago.
3. Both stages should respect `getOwnerRepo(repoPath)` and scope
   queries to `--repo O/R`, so a branch pushed to multiple remotes
   never pulls in a PR from a different fork.

Accepting a merged/closed PR as the match is fine — the renderer
shows that state — **as long as** `headRefOid === headSha`. The
renderer already handles all `PRInfo.state` values; no UI change.

## Edge cases

1. **No upstream configured.** Stage 1 errors; stage 2 runs. If the
   branch has never been pushed (no matching PR by SHA either), we
   return `null` — correct.
2. **Detached HEAD during rebase.** `getPRForBranch` early-returns on
   empty branch name (`client.ts:751`); that check moves into the
   resolver unchanged. If we do run with a branch name but HEAD is
   detached on the PR's tip, stage 2 still resolves correctly via
   `rev-parse HEAD`.
3. **Upstream is set but no PR exists yet.** Stage 1 returns empty;
   stage 2 runs and also finds nothing; we return `null`. Correct.
4. **Upstream points at a local ref (e.g. `refs/heads/main`).** The
   regex fails; stage 1 falls through to stage 2. Unusual config,
   acceptable behavior.
5. **SHA matches a merged PR but heads differ.** Common when a
   commit lands via rebase-merge and the branch name gets reused.
   Stage 2's `headRefOid === headSha` check rejects it; we return
   `null` rather than a misleading old PR.
6. **Multiple remotes.** `getOwnerRepo` already resolves to `origin`'s
   owner/repo. Stage 1's upstream-stripping regex handles any remote
   name. If a branch tracks a non-`origin` remote that points at the
   same GitHub repo, both stages still work. Cross-repo fork cases
   (tracking a fork's remote) are out of scope for this fix — they
   need an explicit cross-repo lookup that Orca doesn't currently
   support anywhere.
7. **Submodules.** Out of scope. Submodule worktrees don't flow
   through `getPRForBranch` today, and we're not adding that path.
8. **Worktree path.** Upstream config lives in the main repo's
   `.git/config`, shared across worktrees. `gitExecFileAsync` with
   `cwd: worktreePath` reads the same config. No special handling.

## Silent failure (acknowledged limitation)

Even with the cascade, "no PR found" still collapses two distinct
outcomes: *no PR exists yet* and *we couldn't resolve this branch to
a PR*. For this round we log the resolution path at debug level and
leave the UI unchanged — Orca just shows the "no PR" state.

A future iteration could change the return type to a tri-state —
`{ kind: 'found', pr } | { kind: 'none' } | { kind: 'unresolved', reason }`
— and surface an "unresolved" hint in the PR card. That's a larger
UX change (renderer, IPC, cache shape) and out of scope here; calling
it out so we remember the gap.

## Observability

Debug-level log at each resolution decision:

```ts
log.debug(`[pr-for-branch] stage=upstream-name localBranch=${b} remoteName=${r}`)
log.debug(`[pr-for-branch] stage=sha-fallback headSha=${sha.slice(0,7)}`)
log.debug(`[pr-for-branch] result=found stage=${n} pr=#${pr.number}`)
log.debug(`[pr-for-branch] result=null reason=${reason}`)
```

Kept at debug because divergence is not itself an error. Enough
signal to diagnose future "PR not showing" reports without re-deriving
the user's config by hand.

## Cache key implication

The renderer caches PR lookups under `${repoPath}::${branch}` where
`branch` is the **local** name
(`src/renderer/src/store/slices/github.ts:387`). This fix does **not**
change the cache key — two worktrees with different local names but
the same upstream make two separate lookups and cache separately.
That's fine: they're different worktrees at different paths, and
`repoPath` in the key already disambiguates them.

We should *not* switch the cache key to the resolved remote name or
to the HEAD SHA. Doing so would require the renderer to know the
resolved identity, which means either plumbing it back through IPC
or duplicating the resolution in the renderer. Neither is worth the
minor cache efficiency.

## Performance

- Stage 1 adds one `git rev-parse --symbolic-full-name @{upstream}`
  per PR poll (a few ms). This is the only extra call in the common
  case where upstream is configured and matches.
- Stage 2 runs only when stage 1 errors or returns empty. It adds
  one `git rev-parse HEAD` plus one `gh pr list --search`.
- Both git calls are cheap and run *outside* the `acquire()` lock,
  which is there to throttle concurrent `gh` processes, not git.
  The `gh` calls inside each stage keep using `acquire()`/`release()`
  as today.

The renderer polls on focus and worktree open, not in a tight loop,
so the extra calls are negligible even in the fallback path.

## Files to change

- **New** `src/main/github/branch-pr-resolution.ts` — cascade +
  validation + debug logging. Exports `resolvePRForBranch`.
- **New** `src/main/github/branch-pr-resolution.test.ts` — covers:
  - Upstream matches local: stage 1 resolves, stage 2 not called.
  - Upstream differs from local: stage 1 resolves to remote name,
    returns PR.
  - Upstream set but no PR yet: stage 1 runs, `gh pr list --head`
    returns `[]`, stage 2 runs and returns `null`. (The empty-array
    case is distinct from the stage-1-errors case and both must fall
    through.)
  - No upstream: stage 1 skipped, stage 2 matches by SHA with equal
    heads.
  - No upstream, SHA search returns a PR whose `headRefOid` differs:
    rejected, returns `null`.
  - Upstream errors, SHA search returns empty: returns `null`.
  - Upstream points at `refs/heads/*`: falls through to stage 2.
  - Branch-name edge: `refs/heads/` prefix stripped before use.
- **Modify** `src/main/github/client.ts` — `getPRForBranch` delegates
  to `resolvePRForBranch`. Keep the empty-branch early return (move
  it into the resolver for symmetry).
- **Modify** `src/main/github/client.test.ts` — drop branch-resolution
  cases in favor of a mocked-resolver boundary test.

No changes expected in `src/main/ipc/github.ts`,
`src/main/runtime/orca-runtime.ts`, `src/main/ipc/worktree-remote.ts`,
or any renderer code — resolution remains an internal detail.

## Why the renderer stays local-branch-centric

The renderer's input is the worktree's local branch — that's what it
knows, and it's the stable identifier for caching and UI. Both the
remote-name derivation and the SHA fallback are git/gh concerns, not
renderer concerns, and belong next to the other git shell-outs in
the main process. Keeping the renderer local-branch-centric also
means the fix has no IPC surface impact.

## Risks and rollout

- **Backwards compatibility.** Users whose local and remote branch
  names already match see identical behavior — stage 1 resolves to
  the same name on the first try.
- **False positives.** The SHA fallback's equality check on
  `headRefOid` is the key guard. Without it, long-lived branches
  could match unrelated PRs; with it, we only match when heads are
  identical.
- **Search-index lag.** GitHub's code/PR search indexes commits
  asynchronously (seconds to ~a minute after push). Stage 2 can miss
  a PR whose head commit was pushed moments ago. On the next poll the
  commit is found. Acceptable: the window is short and the failure
  mode (`null`) matches the pre-push state.
- **Extra gh calls.** Only in the fallback path, and only one extra
  `gh pr list --search` per poll. Bounded.
- **Rollout.** Pure main-process change. Ship behind no flag — the
  existing behavior is a silent bug, and the new behavior's failure
  mode (return `null`) is identical to the old one.
