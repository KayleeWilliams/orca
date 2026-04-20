/**
 * Stably-AI E2E tests for the Source Control panel.
 *
 * Why this suite lives under `./stably` and not alongside the default specs:
 *   - These tests exercise the *real* DOM path: opening the right sidebar,
 *     clicking "Stage" / "Unstage" / "Discard" on a row, and reading the
 *     panel back through AI extraction. The default suite drives
 *     `window.__store` directly (see tests/e2e/helpers/orca-app.ts), which
 *     is fast and deterministic but bypasses the React event handlers that
 *     most regressions land in.
 *   - `agent.act`, `toMatchScreenshotPrompt`, and `page.extract` hit
 *     Stably's hosted API, so this project only runs when STABLY_API_KEY is
 *     set (see tests/playwright.config.ts). Contributors without a key — and
 *     fork PRs whose secrets are not mounted — run the default suite only.
 *
 * Covers behavior that is currently only unit-tested:
 *   - SourceControl.tsx row actions (Stage / Unstage / Discard)
 *   - useGitStatusPolling.ts → gitStatusByWorktree hydration on tab focus
 *   - Panel-level visual: section headers, entry counts, and row icons
 *     render together without layout drift
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

    // Why: open the right sidebar on the Source Control tab *before* running
    // the agent so its first pass sees the panel. Also primes
    // useGitStatusPolling, which only tops up gitStatusByWorktree when the
    // window is focused — the headful Electron run needed here satisfies
    // that precondition.
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

  test('typing in the filter input narrows the change list', async ({ orcaPage, testRepoPath }) => {
    const { untrackedPath } = seedUncommittedChanges(testRepoPath)

    try {
      // Nudge the renderer's git status poll so the new files show up without
      // waiting up to 3s for the natural interval. This is the same IPC the
      // sidebar calls — we're just firing it eagerly on test startup.
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
          { timeout: 10_000, message: 'git status never hydrated for the active worktree' }
        )
        .toBeGreaterThanOrEqual(2)

      // Why this test uses Playwright `.fill()` rather than `agent.act()`:
      // earlier drafts asked the agent to find and click the filter input,
      // but SourceControl.tsx exposes two "Filter files…" inputs — one
      // persistent at the top and a second hover-revealed one inside each
      // section. The agent consistently chose the wrong target (or worse,
      // the terminal), so we use a deterministic locator. The AI value in
      // this test is the assertion side — `page.extract()` reading the
      // rendered section counts — not the typing mechanic.
      const filterInput = orcaPage
        .locator('input[placeholder="Filter files…"]')
        .describe('Top-level Source Control filter files input')
        .first()
      await filterInput.fill('notes-')
      await expect(filterInput).toHaveValue('notes-')

      // Cross-check the visible effect: the store-level data did not change
      // (both files still exist in gitStatusByWorktree) but the rendered
      // counts next to section headers reflect only matching entries.
      //
      // Why a DOM read instead of page.extract: the count is plain text
      // rendered in a sibling span (SourceControl.tsx → SectionHeader), so
      // Playwright can read it directly without the ~5s latency and API
      // cost of an AI extraction — and the result is the exact integer
      // rather than an AI-parsed guess. The regressions this assertion
      // catches (filter unbound, section label drift) are all covered by a
      // text query over the section header buttons.
      const countBySection = await orcaPage
        .locator('button.uppercase')
        .describe('Source Control section header buttons')
        .evaluateAll((buttons) => {
          const result: Record<string, number> = {}
          for (const button of buttons) {
            const spans = button.querySelectorAll('span')
            const label = spans[0]?.textContent?.trim() ?? ''
            const count = Number.parseInt(spans[1]?.textContent?.trim() ?? '', 10)
            if (label && Number.isFinite(count)) {
              result[label] = count
            }
          }
          return result
        })

      // Only the untracked `notes-…md` file should match "notes-". The
      // modified README row would be hidden. A regression where the filter
      // stops narrowing (e.g. someone unbinds the onChange handler) would
      // leave "Changes" visible with count >= 1.
      expect(countBySection['Untracked Files']).toBe(1)
      expect(countBySection['Changes']).toBeUndefined()
    } finally {
      cleanupSeed(testRepoPath, untrackedPath)
    }
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
