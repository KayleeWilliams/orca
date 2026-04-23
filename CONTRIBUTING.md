# Contributing to Orca

Thanks for contributing to Orca.

## Before You Start

- Keep changes scoped to a clear user-facing improvement, bug fix, or refactor.
- Orca targets macOS, Linux, and Windows. Avoid platform-specific assumptions in shortcuts, labels, and file paths.
- For keyboard shortcuts, use runtime platform checks in renderer code and `CmdOrCtrl` in Electron menu accelerators.
- For shortcut labels, show `⌘` and `⇧` on macOS, and `Ctrl+` and `Shift+` on Linux and Windows.
- For file paths, use Node or Electron path utilities such as `path.join`.

## Local Setup

```bash
pnpm install
pnpm dev
```

## Branch Naming

Use a clear, descriptive branch name that reflects the change.

Good examples:

- `fix/ctrl-backspace-delete-word`
- `feat/shift-enter-newline`
- `chore/update-contributor-guide`

Avoid vague names like `test`, `misc`, or `changes`.

## Before Opening a PR

Run the same checks that CI runs:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Add high-quality tests for behavior changes and bug fixes. Prefer tests that would actually catch a regression, not shallow coverage that only exercises the happy path.

If your change affects UI or interaction behavior, verify it on the platforms it could impact.

## Pull Requests

Each pull request should:

- explain the user-visible change
- stay focused on a single topic when possible
- include screenshots or screen recordings for new UI or behavior changes
- include high-quality tests when behavior changes or bug fixes warrant them
- include a brief code review summary from your AI coding agent that explicitly checks cross-platform compatibility, plus a basic security audit summary
- mention any platform-specific behavior or testing notes
- **Include your X (Twitter) handle!** We love giving shoutouts to our contributors when we merge features on [@orca_build](https://x.com/orca_build).

If there is no visual change, say that explicitly in the PR description.

## Release Process

Version bumps, tags, and releases are maintainer-managed. Do not include release version changes in a normal contribution unless a maintainer asks for them.

### Cutting a release (maintainers)

All releases are cut from the **Cut Release** GitHub Actions workflow. There is no local `pnpm release:*` script — running releases locally is too easy to get wrong (dirty tree, wrong branch, stale main).

**To cut a release:**

1. Open [Actions → Cut Release](../../actions/workflows/release-cut.yml).
2. Click **Run workflow** and pick:
   - **kind**: `rc` for a release candidate, `stable` for a public release.
   - **ref**: the branch, tag, or SHA to build from. Defaults to `main`.
   - **version** *(optional)*: an explicit base version like `1.4.0`. Leave blank to auto-compute.
3. Run it.

The workflow resolves the next version from GitHub Releases, bumps `package.json`, tags, pushes, and kicks off the multi-platform build via `release.yml`.

**Version auto-compute rules (when `version` is blank):**

- `kind=rc` on top of a stable (e.g. last tag was `v1.3.14`) → `v1.3.15-rc.0`.
- `kind=rc` on top of an existing RC series (e.g. last tag was `v1.3.15-rc.2`) → `v1.3.15-rc.3`.
- `kind=stable` on top of an RC series (e.g. last tag was `v1.3.15-rc.3`) → `v1.3.15` (promotes the RC base to stable).
- `kind=stable` on top of a stable → the next patch (e.g. `v1.3.14` → `v1.3.15`). Use the explicit `version` input for minor/major bumps.

**Safety guarantees:**

- Stable releases are refused if the new version isn't strictly greater than the latest published stable. This is the only rule `electron-updater` actually needs — it compares semver within the `latest` channel, so a regressing stable is the one thing that breaks auto-update for fresh installs.
- Off-main releases (when `ref` is not the tip of `main`) only push the tag. `main` is never mutated from a non-main ref, so you can safely release an older commit without polluting history.
- When `ref` is the tip of `main`, the version-bump commit is fast-forwarded onto `main` so local `package.json` stays in sync with what's shipped.

**Common scenarios:**

- **Normal release:** `kind=stable`, `ref=main`, `version=` blank.
- **"A bad commit just landed on main, release the commit before it":** `kind=stable`, `ref=<good-sha>`, `version=` blank. `main` is left alone; the tag points at the good SHA. Fix forward on `main` afterward.
- **One-off RC for a feature branch:** `kind=rc`, `ref=<branch-or-sha>`. Produces an RC tag that does not touch `main`.
- **Minor or major bump:** `kind=stable`, `version=1.4.0` (or `2.0.0`).

The scheduled 2x/day RC cron in [`release-rc.yml`](../../actions/workflows/release-rc.yml) is independent and continues to run automatically from `main`.
