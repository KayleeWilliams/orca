import { useEffect, useCallback, useRef } from 'react'
import { useAppStore } from '../store'
import TabBar from './TabBar'
import TerminalPane from './TerminalPane'

export default function Terminal(): React.JSX.Element | null {
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const createTab = useAppStore((s) => s.createTab)
  const closeTab = useAppStore((s) => s.closeTab)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const reorderTabs = useAppStore((s) => s.reorderTabs)
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)

  if (!activeWorktreeId) return null

  const tabs = tabsByWorktree[activeWorktreeId] ?? []
  const prevTabCountRef = useRef(tabs.length)
  const tabBarRef = useRef<HTMLDivElement>(null)

  // Find the active worktree to get its path
  const activeWorktree = activeWorktreeId
    ? Object.values(worktreesByRepo)
        .flat()
        .find((w) => w.id === activeWorktreeId)
    : null

  const cwd = activeWorktree?.path

  // Auto-create first tab when worktree activates
  useEffect(() => {
    if (activeWorktreeId && tabs.length === 0) {
      createTab(activeWorktreeId)
    }
  }, [activeWorktreeId, tabs.length, createTab])

  // Ensure activeTabId is valid
  useEffect(() => {
    if (tabs.length > 0 && (!activeTabId || !tabs.find((t) => t.id === activeTabId))) {
      setActiveTab(tabs[0].id)
    }
  }, [tabs, activeTabId, setActiveTab])

  // Animate tab bar height with grid transition
  useEffect(() => {
    const el = tabBarRef.current
    if (!el) return

    const showBar = tabs.length >= 2
    if (showBar) {
      el.style.gridTemplateRows = '1fr'
    } else {
      el.style.gridTemplateRows = '0fr'
    }
    prevTabCountRef.current = tabs.length
  }, [tabs.length])

  const handleNewTab = useCallback(() => {
    createTab(activeWorktreeId)
  }, [activeWorktreeId, createTab])

  const handleCloseTab = useCallback(
    (tabId: string) => {
      const currentTabs = useAppStore.getState().tabsByWorktree[activeWorktreeId] ?? []
      if (currentTabs.length <= 1) {
        // Last tab - deactivate worktree
        closeTab(tabId)
        setActiveWorktree(null)
        return
      }

      // If closing the active tab, switch to a neighbor
      if (tabId === useAppStore.getState().activeTabId) {
        const idx = currentTabs.findIndex((t) => t.id === tabId)
        const nextTab = currentTabs[idx + 1] ?? currentTabs[idx - 1]
        if (nextTab) setActiveTab(nextTab.id)
      }
      closeTab(tabId)
    },
    [activeWorktreeId, closeTab, setActiveTab, setActiveWorktree]
  )

  const handlePtyExit = useCallback(
    (tabId: string) => {
      handleCloseTab(tabId)
    },
    [handleCloseTab]
  )

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // Cmd+T - new tab
      if (e.metaKey && e.key === 't' && !e.shiftKey && !e.repeat) {
        e.preventDefault()
        handleNewTab()
        return
      }

      // Cmd+W - close active tab
      if (e.metaKey && e.key === 'w' && !e.shiftKey && !e.repeat) {
        e.preventDefault()
        const currentActiveTabId = useAppStore.getState().activeTabId
        if (currentActiveTabId) {
          handleCloseTab(currentActiveTabId)
        }
        return
      }

      // Cmd+Shift+] and Cmd+Shift+[ - switch tabs
      if (e.metaKey && e.shiftKey && (e.key === ']' || e.key === '[') && !e.repeat) {
        const currentTabs = useAppStore.getState().tabsByWorktree[activeWorktreeId] ?? []
        if (currentTabs.length > 1) {
          e.preventDefault()
          const currentId = useAppStore.getState().activeTabId
          const idx = currentTabs.findIndex((t) => t.id === currentId)
          const dir = e.key === ']' ? 1 : -1
          const next = currentTabs[(idx + dir + currentTabs.length) % currentTabs.length]
          if (next) setActiveTab(next.id)
        }
        return
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [activeWorktreeId, handleNewTab, handleCloseTab, setActiveTab])

  return (
    <div className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden">
      {/* Animated tab bar container using CSS grid for smooth height animation */}
      <div
        ref={tabBarRef}
        className="grid transition-[grid-template-rows] duration-200 ease-in-out"
        style={{ gridTemplateRows: tabs.length >= 2 ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <TabBar
            tabs={tabs}
            activeTabId={activeTabId}
            worktreeId={activeWorktreeId}
            onActivate={setActiveTab}
            onClose={handleCloseTab}
            onReorder={reorderTabs}
            onNewTab={handleNewTab}
          />
        </div>
      </div>

      {/* Terminal panes container */}
      <div className="relative flex-1 min-h-0 overflow-hidden">
        {tabs.map((tab) => (
          <TerminalPane
            key={tab.id}
            tabId={tab.id}
            cwd={cwd}
            isActive={tab.id === activeTabId}
            onPtyExit={() => handlePtyExit(tab.id)}
          />
        ))}
      </div>
    </div>
  )
}
