/**
 * Stably-AI E2E tests for the Source Control panel.
 *
 * Why this suite lives under `./stably` and not alongside the default specs:
 *   - `toMatchScreenshotPrompt` hits Stably's hosted API, so this project
 *     only runs when STABLY_API_KEY is set (see tests/playwright.config.ts).
 *     Contributors without a key — and fork PRs whose secrets are not
 *     mounted — run the default suite only.
 *   - The default suite drives `window.__store` directly (see
 *     tests/e2e/helpers/orca-app.ts); this suite renders the populated
 *     panel and asserts its structural layout through an intent-based
 *     visual, which catches regressions (section disappearing, filter
 *     input vanishing, row layout collapsing) that a store-level check
 *     cannot see.
 */

import { existsSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'
import path from 'path'
import { test, expect } from '../helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree, ensureTerminalVisible } from '../helpers/store'

/**
 * Seed uncommitted changes on disk so SourceControl has something to render.
 *
 * Why direct fs + git commands instead of `window.api.git`:
 *   The IPC layer only exposes stage/unstage/discard — not "write a file".
 *   Dirtying the working tree from Node mirrors how a developer or another
 *   tool would change files, which is the real input SourceControl reads.
 */
function seedUncommittedChanges(repoPath: string): { modifiedPath: string; untrackedPath: string } {
  if (!existsSync(repoPath)) {
    throw new Error(`seed repo missing at ${repoPath}`)
  }

  // Why: a unique suffix per call keeps git status deterministic even when
  // Playwright retries a test or both tests in this file run in the same
  // worker — each invocation edits fresh paths rather than inheriting
  // half-staged files from a previous attempt. The random suffix ensures
  // uniqueness even if two calls land in the same millisecond.
  const runTag = `stably-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  const modifiedPath = 'README.md'
  const untrackedPath = `notes-${runTag}.md`

  writeFileSync(
    path.join(repoPath, modifiedPath),
    `# Orca E2E Test Repo\n\nStably tag: ${runTag}\n`
  )
  writeFileSync(path.join(repoPath, untrackedPath), `Untracked scratch file for ${runTag}.\n`)
  return { modifiedPath, untrackedPath }
}

/**
 * Revert seed edits after the test so subsequent tests in the same worker
 * don't inherit dirty state. Best-effort — if git is unhappy we swallow it
 * rather than masking the real test assertion.
 */
function cleanupSeed(repoPath: string, untrackedPath: string): void {
  try {
    execSync('git checkout -- README.md', { cwd: repoPath, stdio: 'pipe' })
  } catch {
    /* already clean */
  }
  try {
    // Why the scoped pathspec: `testRepoPath` is a worker-scoped fixture
    // shared across tests in the same worker, so an unscoped
    // `git reset HEAD -- .` would unstage paths a concurrent or prior
    // test owns. Restrict to only the files this seed actually touched.
    execSync(`git reset HEAD -- README.md "${untrackedPath}"`, {
      cwd: repoPath,
      stdio: 'pipe'
    })
  } catch {
    /* nothing staged */
  }
  const untracked = path.join(repoPath, untrackedPath)
  if (existsSync(untracked)) {
    try {
      execSync(`rm -f "${untracked}"`, { stdio: 'pipe' })
    } catch {
      /* ignore */
    }
  }
}

test.describe('Source Control (AI-driven)', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)

    // Why: open the right sidebar on the Source Control tab *before* the
    // screenshot assertion so the panel is visible in the captured frame.
    // Also primes useGitStatusPolling, which only tops up
    // gitStatusByWorktree when the window is focused — the headful
    // Electron run needed here satisfies that precondition.
    await orcaPage.evaluate(() => {
      const store = window.__store
      if (!store) {
        return
      }
      const state = store.getState()
      state.setRightSidebarTab('source-control')
      state.setRightSidebarOpen(true)
    })
  })

  test('populated Source Control panel matches the expected layout', async ({
    orcaPage,
    testRepoPath
  }) => {
    const { untrackedPath } = seedUncommittedChanges(testRepoPath)

    try {
      await orcaPage.evaluate(async () => {
        const store = window.__store
        if (!store) {
          return
        }
        const state = store.getState()
        const worktreeId = state.activeWorktreeId
        if (!worktreeId) {
          return
        }
        const worktree = Object.values(state.worktreesByRepo)
          .flat()
          .find((entry) => entry.id === worktreeId)
        if (!worktree) {
          return
        }
        const status = await window.api.git.status({ worktreePath: worktree.path })
        state.setGitStatus(worktreeId, status as Parameters<typeof state.setGitStatus>[1])
      })

      await expect
        .poll(
          async () =>
            orcaPage.evaluate(() => {
              const state = window.__store?.getState()
              if (!state?.activeWorktreeId) {
                return 0
              }
              return (state.gitStatusByWorktree[state.activeWorktreeId] ?? []).length
            }),
          { timeout: 10_000 }
        )
        .toBeGreaterThan(0)

      // Why an AI visual: the panel mixes status icons, section headers
      // with counts, a filter input, and the branch compare banner. A
      // pixel-exact `toHaveScreenshot` would flap on font hinting, OS
      // scroll bars, and the live branch-compare spinner. An intent-based
      // prompt catches structural regressions (a section disappearing, the
      // filter input vanishing, row layout collapsing) without over-
      // specifying pixels.
      //
      // Why the prompt avoids mentioning action buttons: stage/unstage/
      // discard icons only appear on hover, and the status letter ("M"/
      // "U") on the right is what's statically visible. An earlier draft
      // that required "an action button on the right" failed because the
      // AI correctly reported that the steady-state UI doesn't render one.
      await expect(
        orcaPage
          .locator('aside, [data-slot="sidebar-panel"], .flex.h-full.flex-col')
          .describe('Right sidebar with Source Control panel')
          .first()
      ).toMatchScreenshotPrompt(
        'Source Control panel shows a filter input labeled "Filter files…" at the top, at least one section header ("CHANGES", "STAGED CHANGES", or "UNTRACKED FILES") followed by a numeric count, and at least one file row beneath a section header that includes a colored status glyph on the left and a single-letter status indicator (such as "M" or "U") near the right edge.',
        { timeout: 30_000 }
      )
    } finally {
      cleanupSeed(testRepoPath, untrackedPath)
    }
  })
})
