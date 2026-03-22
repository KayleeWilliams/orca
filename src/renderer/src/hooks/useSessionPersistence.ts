import { useEffect } from 'react'
import { useAppStore } from '../store'

/**
 * Persists workspace session and UI preferences to disk via IPC.
 *
 * Extracted from App.tsx so that changes to persisted values (e.g. sidebarWidth,
 * activeTabId) trigger IPC calls WITHOUT re-rendering the App component tree.
 * Each subscription fires independently — a sidebar resize won't re-render
 * Terminal, TabBar, etc.
 */
export function useSessionPersistence(): void {
  // ── Workspace session persistence (150ms debounce) ────────────
  const workspaceSessionReady = useAppStore((s) => s.workspaceSessionReady)
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const terminalLayoutsByTabId = useAppStore((s) => s.terminalLayoutsByTabId)

  useEffect(() => {
    if (!workspaceSessionReady) return

    const timer = window.setTimeout(() => {
      void window.api.session.set({
        activeRepoId,
        activeWorktreeId,
        activeTabId,
        tabsByWorktree,
        terminalLayoutsByTabId
      })
    }, 150)

    return () => window.clearTimeout(timer)
  }, [
    workspaceSessionReady,
    activeRepoId,
    activeWorktreeId,
    activeTabId,
    tabsByWorktree,
    terminalLayoutsByTabId
  ])

  // ── UI preferences persistence (150ms debounce) ───────────────
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const groupBy = useAppStore((s) => s.groupBy)
  const sortBy = useAppStore((s) => s.sortBy)

  useEffect(() => {
    if (!persistedUIReady) return

    const timer = window.setTimeout(() => {
      void window.api.ui.set({
        sidebarWidth,
        groupBy,
        sortBy
      })
    }, 150)

    return () => window.clearTimeout(timer)
  }, [persistedUIReady, sidebarWidth, groupBy, sortBy])
}
