/**
 * E2E tests for opening files and markdown preview from the right sidebar.
 *
 * User Prompt:
 * - you can open files (from the right sidebar)
 * - you can open .md files and they show up as preview (from the right sidebar)
 */

import { test, expect } from './helpers/orca-app'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  getActiveTabType,
  getOpenFiles,
  ensureTerminalVisible
} from './helpers/store'
import { clickFileInExplorer, openFileExplorer } from './helpers/file-explorer'

async function switchToTerminal(
  page: Parameters<typeof getActiveWorktreeId>[0],
  worktreeId: string
): Promise<void> {
  await page.evaluate((targetWorktreeId) => {
    const store = window.__store
    if (!store) {
      return
    }

    const state = store.getState()
    const terminalTab = (state.tabsByWorktree[targetWorktreeId] ?? [])[0]
    if (terminalTab) {
      state.setActiveTab(terminalTab.id)
    }
    state.setActiveTabType('terminal')
  }, worktreeId)
}

async function switchToEditor(
  page: Parameters<typeof getActiveWorktreeId>[0],
  fileId: string
): Promise<void> {
  await page.evaluate((targetFileId) => {
    const store = window.__store
    if (!store) {
      return
    }

    const state = store.getState()
    if (state.openFiles.some((file) => file.id === targetFileId)) {
      state.setActiveFile(targetFileId)
      state.setActiveTabType('editor')
    }
  }, fileId)
}

test.describe('File Open & Markdown Preview', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  /**
   * User Prompt:
   * - you can open files (from the right sidebar)
   */
  test('opening the right sidebar shows file explorer', async ({ orcaPage }) => {
    await openFileExplorer(orcaPage)

    // Verify the right sidebar is open and on the explorer tab
    await expect
      .poll(async () => orcaPage.evaluate(() => window.__store?.getState().rightSidebarOpen), {
        timeout: 3_000
      })
      .toBe(true)

    await expect
      .poll(async () => orcaPage.evaluate(() => window.__store?.getState().rightSidebarTab), {
        timeout: 3_000
      })
      .toBe('explorer')
  })

  /**
   * User Prompt:
   * - you can open files (from the right sidebar)
   */
  test('clicking a file in the file explorer opens it in an editor tab', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!
    await openFileExplorer(orcaPage)

    const filesBefore = await getOpenFiles(orcaPage, worktreeId)

    // Click a known non-directory file
    const clickedFile = await clickFileInExplorer(orcaPage, [
      'package.json',
      'tsconfig.json',
      '.gitignore',
      'README.md'
    ])
    expect(clickedFile).not.toBeNull()

    // Wait for the file to be opened in the editor
    await expect.poll(async () => getActiveTabType(orcaPage), { timeout: 5_000 }).toBe('editor')

    // There should be a new open file
    await expect
      .poll(async () => (await getOpenFiles(orcaPage, worktreeId)).length, { timeout: 5_000 })
      .toBeGreaterThan(filesBefore.length)
  })

  /**
   * User Prompt:
   * - you can open .md files and they show up as preview (from the right sidebar)
   */
  test('opening a .md file shows markdown content', async ({ orcaPage }) => {
    await openFileExplorer(orcaPage)
    const clickedFile = await clickFileInExplorer(orcaPage, ['README.md', 'CLAUDE.md'])
    expect(clickedFile).not.toBeNull()

    // Wait for the editor tab to become active
    await expect.poll(async () => getActiveTabType(orcaPage), { timeout: 5_000 }).toBe('editor')

    // The seeded README.md starts with `# Orca E2E Test Repo`, so the rich
    // markdown editor should render a real <h1> with that text. Asserting on
    // the rendered heading (not `markdownViewMode` in the store) is the whole
    // point of this spec — a store-only check passes even if
    // RichMarkdownEditor failed to mount and the editor surface is blank.
    // Fall back to CLAUDE.md's first heading when that file was opened
    // instead: the seeded `CLAUDE.md` starts with `# CLAUDE.md`.
    const expectedHeading = clickedFile?.endsWith('README.md')
      ? /Orca E2E Test Repo/i
      : /CLAUDE\.md/i
    await expect(orcaPage.getByRole('heading', { name: expectedHeading, level: 1 })).toBeVisible({
      timeout: 15_000
    })
  })

  /**
   * User Prompt:
   * - you can open files (from the right sidebar)
   * - files retain state when switching tabs
   */
  test('editor tab retains state when switching to terminal and back', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!
    await openFileExplorer(orcaPage)

    // Click a file to open it
    const clickedFile = await clickFileInExplorer(orcaPage, [
      'package.json',
      'tsconfig.json',
      '.gitignore'
    ])
    expect(clickedFile).not.toBeNull()

    // Wait for editor to become active
    await expect.poll(async () => getActiveTabType(orcaPage), { timeout: 5_000 }).toBe('editor')

    // Record what files are open
    const openFilesBefore = await getOpenFiles(orcaPage, worktreeId)
    expect(openFilesBefore.length).toBeGreaterThan(0)

    const editorFileId = openFilesBefore[0].id

    // Switch to a terminal tab
    await switchToTerminal(orcaPage, worktreeId)
    await expect.poll(async () => getActiveTabType(orcaPage), { timeout: 3_000 }).not.toBe('editor')

    // Switch back to the same editor tab
    await switchToEditor(orcaPage, editorFileId)
    await expect.poll(async () => getActiveTabType(orcaPage), { timeout: 3_000 }).toBe('editor')

    // The same files should still be open
    const openFilesAfter = await getOpenFiles(orcaPage, worktreeId)
    expect(openFilesAfter.length).toBe(openFilesBefore.length)
    expect(openFilesAfter[0].filePath).toBe(openFilesBefore[0].filePath)
  })
})
