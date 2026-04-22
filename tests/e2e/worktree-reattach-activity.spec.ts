/**
 * E2E test guarding against PTY reattach bumping a worktree's lastActivityAt.
 *
 * Why this exists:
 *   PTY reattach (deferred daemon reattach on cold start, daemon-off split
 *   remount, pending-spawn reuse) calls updateTabPtyId to rebind an existing
 *   PTY to its tab. Before the fix, that call unconditionally fired
 *   bumpWorktreeActivity, stamping lastActivityAt = Date.now() on the
 *   worktree. When background worktrees reattached terminals after a cold
 *   start, this knocked a just-created foreground worktree out of Recent's
 *   top slot even though the user had just made it.
 *
 *   The fix adds an `isReattach: true` option to updateTabPtyId that skips
 *   the activity bump. This test exercises that contract through the live
 *   Zustand store inside the real Electron runtime.
 */

import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree } from './helpers/store'

test.describe('Worktree PTY reattach activity', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('updateTabPtyId with isReattach does not bump lastActivityAt', async ({ orcaPage }) => {
    const { before, after } = await orcaPage.evaluate(() => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is unavailable')
      }

      const state = store.getState()
      const activeWorktreeId = state.activeWorktreeId
      if (!activeWorktreeId) {
        throw new Error('No active worktree')
      }

      // Why: seed a known lastActivityAt so the assertion below can detect any
      // write. bumpWorktreeActivity would overwrite this with Date.now().
      const seedValue = 42
      store.setState((s) => {
        const worktreesByRepo = { ...s.worktreesByRepo }
        for (const repoId of Object.keys(worktreesByRepo)) {
          worktreesByRepo[repoId] = worktreesByRepo[repoId].map((w) =>
            w.id === activeWorktreeId ? { ...w, lastActivityAt: seedValue } : w
          )
        }
        return { worktreesByRepo }
      })

      const tabs = state.tabsByWorktree[activeWorktreeId] ?? []
      let tabId = tabs[0]?.id
      if (!tabId) {
        tabId = state.createTab(activeWorktreeId)
      }

      const readActivity = (): number => {
        const current = Object.values(store.getState().worktreesByRepo)
          .flat()
          .find((w) => w.id === activeWorktreeId)
        return current?.lastActivityAt ?? -1
      }

      const before = readActivity()
      // Why: simulate the reattach code path in pty-connection.ts. The
      // synthetic PTY ID never collides with a real one because it's prefixed.
      store.getState().updateTabPtyId(tabId, 'e2e-reattach-test-pty', { isReattach: true })
      const after = readActivity()

      return { before, after }
    })

    // Why: the seed value was 42; if reattach had fallen through to
    // bumpWorktreeActivity, `after` would be Date.now() — orders of
    // magnitude larger than 42.
    expect(before).toBe(42)
    expect(after).toBe(42)
  })

  test('updateTabPtyId without isReattach still bumps lastActivityAt (happy-path regression)', async ({
    orcaPage
  }) => {
    // Why: ensures the fix is surgical. Fresh PTY spawns must still count as
    // activity — if isReattach accidentally became the default, Recent would
    // stop reacting to real user actions.
    const { before, after } = await orcaPage.evaluate(() => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is unavailable')
      }

      const state = store.getState()
      const activeWorktreeId = state.activeWorktreeId
      if (!activeWorktreeId) {
        throw new Error('No active worktree')
      }

      store.setState((s) => {
        const worktreesByRepo = { ...s.worktreesByRepo }
        for (const repoId of Object.keys(worktreesByRepo)) {
          worktreesByRepo[repoId] = worktreesByRepo[repoId].map((w) =>
            w.id === activeWorktreeId ? { ...w, lastActivityAt: 42 } : w
          )
        }
        return { worktreesByRepo }
      })

      const tabs = state.tabsByWorktree[activeWorktreeId] ?? []
      let tabId = tabs[0]?.id
      if (!tabId) {
        tabId = state.createTab(activeWorktreeId)
      }

      const readActivity = (): number => {
        const current = Object.values(store.getState().worktreesByRepo)
          .flat()
          .find((w) => w.id === activeWorktreeId)
        return current?.lastActivityAt ?? -1
      }

      const before = readActivity()
      store.getState().updateTabPtyId(tabId, 'e2e-fresh-spawn-test-pty')
      const after = readActivity()

      return { before, after }
    })

    expect(before).toBe(42)
    expect(after).toBeGreaterThan(42)
  })
})
