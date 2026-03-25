import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { useShallow } from 'zustand/react/shallow'
import { TOGGLE_TERMINAL_PANE_EXPAND_EVENT } from '@/constants/terminal'

export type UnifiedTerminalItem = {
  type: 'terminal' | 'editor'
  id: string
}

type UseTerminalTabsResult = ReturnType<typeof useTerminalTabsInner>

export function useTerminalTabs(): UseTerminalTabsResult {
  return useTerminalTabsInner()
}

function useTerminalTabsInner() {
  const {
    activeWorktreeId,
    activeView,
    worktreesByRepo,
    tabsByWorktree,
    activeTabId,
    createTab,
    closeTab,
    setActiveTab,
    reorderTabs,
    setActiveWorktree,
    setTabCustomTitle,
    setTabColor,
    consumeSuppressedPtyExit,
    expandedPaneByTabId,
    workspaceSessionReady,
    openFiles,
    activeFileId,
    activeTabType,
    setActiveTabType,
    setActiveFile,
    closeAllFiles
  } = useAppStore(
    useShallow((s) => ({
      activeWorktreeId: s.activeWorktreeId,
      activeView: s.activeView,
      worktreesByRepo: s.worktreesByRepo,
      tabsByWorktree: s.tabsByWorktree,
      activeTabId: s.activeTabId,
      createTab: s.createTab,
      closeTab: s.closeTab,
      setActiveTab: s.setActiveTab,
      reorderTabs: s.reorderTabs,
      setActiveWorktree: s.setActiveWorktree,
      setTabCustomTitle: s.setTabCustomTitle,
      setTabColor: s.setTabColor,
      consumeSuppressedPtyExit: s.consumeSuppressedPtyExit,
      expandedPaneByTabId: s.expandedPaneByTabId,
      workspaceSessionReady: s.workspaceSessionReady,
      openFiles: s.openFiles,
      activeFileId: s.activeFileId,
      activeTabType: s.activeTabType,
      setActiveTabType: s.setActiveTabType,
      setActiveFile: s.setActiveFile,
      closeAllFiles: s.closeAllFiles
    }))
  )

  const tabs = activeWorktreeId ? (tabsByWorktree[activeWorktreeId] ?? []) : []
  const allWorktrees = Object.values(worktreesByRepo).flat()
  const worktreeFiles = activeWorktreeId
    ? openFiles.filter((file) => file.worktreeId === activeWorktreeId)
    : []
  const totalTabs = tabs.length + worktreeFiles.length
  const unifiedTabs: UnifiedTerminalItem[] = [
    ...tabs.map((tab) => ({ type: 'terminal' as const, id: tab.id })),
    ...worktreeFiles.map((file) => ({ type: 'editor' as const, id: file.id }))
  ]

  const [mountedWorktreeIds, setMountedWorktreeIds] = useState<string[]>([])
  const [initialTabCreationGuard, setInitialTabCreationGuard] = useState<string | null>(null)
  const mountedWorktrees = allWorktrees.filter((worktree) =>
    mountedWorktreeIds.includes(worktree.id)
  )

  useEffect(() => {
    if (tabs.length === 0) {
      return
    }
    if (activeTabId && tabs.some((tab) => tab.id === activeTabId)) {
      return
    }
    setActiveTab(tabs[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tabs is derived from tabsByWorktree which is stable via useShallow
  }, [activeTabId, setActiveTab, tabsByWorktree, activeWorktreeId])

  useEffect(() => {
    setMountedWorktreeIds((current) => {
      const allWorktreeIds = new Set(allWorktrees.map((worktree) => worktree.id))
      const next = current.filter((id) => allWorktreeIds.has(id))
      if (activeWorktreeId && !next.includes(activeWorktreeId)) {
        next.push(activeWorktreeId)
      }
      if (next.length === current.length && next.every((id, index) => id === current[index])) {
        return current
      }
      return next
    })
  }, [activeWorktreeId, allWorktrees])

  useEffect(() => {
    if (!workspaceSessionReady) {
      return
    }
    if (!activeWorktreeId) {
      setInitialTabCreationGuard(null)
      return
    }
    if (tabs.length > 0) {
      if (initialTabCreationGuard === activeWorktreeId) {
        setInitialTabCreationGuard(null)
      }
      return
    }
    if (initialTabCreationGuard === activeWorktreeId) {
      return
    }

    setInitialTabCreationGuard(activeWorktreeId)
    createTab(activeWorktreeId)
  }, [activeWorktreeId, createTab, initialTabCreationGuard, tabs.length, workspaceSessionReady])

  const handleNewTab = useCallback(() => {
    if (!activeWorktreeId) {
      return
    }
    createTab(activeWorktreeId)
  }, [activeWorktreeId, createTab])

  const handleCloseTab = useCallback(
    (tabId: string) => {
      const owningWorktreeEntry = Object.entries(tabsByWorktree).find(([, worktreeTabs]) =>
        worktreeTabs.some((tab) => tab.id === tabId)
      )
      const owningWorktreeId = owningWorktreeEntry?.[0] ?? null

      if (!owningWorktreeId) {
        return
      }

      const currentTabs = tabsByWorktree[owningWorktreeId] ?? []
      if (currentTabs.length <= 1) {
        closeTab(tabId)
        if (activeWorktreeId === owningWorktreeId) {
          setActiveWorktree(null)
        }
        return
      }

      if (activeWorktreeId === owningWorktreeId && tabId === activeTabId) {
        const currentIndex = currentTabs.findIndex((tab) => tab.id === tabId)
        const nextTab = currentTabs[currentIndex + 1] ?? currentTabs[currentIndex - 1]
        if (nextTab) {
          setActiveTab(nextTab.id)
        }
      }

      closeTab(tabId)
    },
    [activeTabId, activeWorktreeId, closeTab, setActiveTab, setActiveWorktree, tabsByWorktree]
  )

  const handlePtyExit = useCallback(
    (tabId: string, ptyId: string) => {
      if (consumeSuppressedPtyExit(ptyId)) {
        return
      }
      handleCloseTab(tabId)
    },
    [consumeSuppressedPtyExit, handleCloseTab]
  )

  const handleCloseOthers = useCallback(
    (tabId: string) => {
      if (!activeWorktreeId) {
        return
      }

      const currentTabs = useAppStore.getState().tabsByWorktree[activeWorktreeId] ?? []
      setActiveTab(tabId)
      for (const tab of currentTabs) {
        if (tab.id !== tabId) {
          closeTab(tab.id)
        }
      }
    },
    [activeWorktreeId, closeTab, setActiveTab]
  )

  const handleCloseTabsToRight = useCallback(
    (tabId: string) => {
      if (!activeWorktreeId) {
        return
      }

      const currentTabs = useAppStore.getState().tabsByWorktree[activeWorktreeId] ?? []
      const currentIndex = currentTabs.findIndex((tab) => tab.id === tabId)
      if (currentIndex === -1) {
        return
      }

      for (const tab of currentTabs.slice(currentIndex + 1)) {
        closeTab(tab.id)
      }
    },
    [activeWorktreeId, closeTab]
  )

  const handleActivateTab = useCallback(
    (tabId: string) => {
      setActiveTab(tabId)
      setActiveTabType('terminal')
    },
    [setActiveTab, setActiveTabType]
  )

  const handleActivateFile = useCallback(
    (fileId: string) => {
      setActiveFile(fileId)
      setActiveTabType('editor')
    },
    [setActiveFile, setActiveTabType]
  )

  const handleTogglePaneExpand = useCallback(
    (tabId: string) => {
      setActiveTab(tabId)
      requestAnimationFrame(() => {
        window.dispatchEvent(
          new CustomEvent(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, {
            detail: { tabId }
          })
        )
      })
    },
    [setActiveTab]
  )

  return {
    activeWorktreeId,
    activeView,
    tabsByWorktree,
    tabs,
    mountedWorktrees,
    worktreeFiles,
    totalTabs,
    unifiedTabs,
    activeTabId,
    activeFileId,
    activeTabType,
    expandedPaneByTabId,
    reorderTabs,
    setTabCustomTitle,
    setTabColor,
    closeAllFiles,
    handleNewTab,
    handleCloseTab,
    handlePtyExit,
    handleCloseOthers,
    handleCloseTabsToRight,
    handleActivateTab,
    handleActivateFile,
    handleTogglePaneExpand
  }
}
