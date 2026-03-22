import { useEffect } from 'react'
import { Toaster } from 'sonner'
import { Minimize2, PanelLeft } from 'lucide-react'
import { TOGGLE_TERMINAL_PANE_EXPAND_EVENT } from '@/constants/terminal'
import { syncZoomCSSVar } from '@/lib/ui-zoom'
import { useAppStore } from './store'
import { useIpcEvents } from './hooks/useIpcEvents'
import { useSessionPersistence } from './hooks/useSessionPersistence'
import Sidebar from './components/Sidebar'
import Terminal from './components/Terminal'
import Landing from './components/Landing'
import Settings from './components/Settings'

function App(): React.JSX.Element {
  // ── Store subscriptions needed for rendering ──────────────────
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const activeView = useAppStore((s) => s.activeView)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const expandedPaneByTabId = useAppStore((s) => s.expandedPaneByTabId)
  const canExpandPaneByTabId = useAppStore((s) => s.canExpandPaneByTabId)
  const openModal = useAppStore((s) => s.openModal)
  const repos = useAppStore((s) => s.repos)
  const settings = useAppStore((s) => s.settings)

  // ── Store subscriptions for one-time init only ────────────────
  const fetchRepos = useAppStore((s) => s.fetchRepos)
  const fetchAllWorktrees = useAppStore((s) => s.fetchAllWorktrees)
  const fetchSettings = useAppStore((s) => s.fetchSettings)
  const initGitHubCache = useAppStore((s) => s.initGitHubCache)
  const hydrateWorkspaceSession = useAppStore((s) => s.hydrateWorkspaceSession)
  const hydratePersistedUI = useAppStore((s) => s.hydratePersistedUI)

  // Subscribe to IPC push events
  useIpcEvents()

  // Session & UI persistence extracted to a dedicated hook so that changes
  // to persisted values (sidebarWidth, activeTabId, etc.) trigger IPC calls
  // WITHOUT re-rendering the entire App component tree.
  useSessionPersistence()

  // Fetch initial data + hydrate GitHub cache from disk
  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        await fetchRepos()
        await fetchAllWorktrees()
        const persistedUI = await window.api.ui.get()
        const session = await window.api.session.get()
        if (!cancelled) {
          hydratePersistedUI(persistedUI)
          hydrateWorkspaceSession(session)
          syncZoomCSSVar()
        }
      } catch (error) {
        console.error('Failed to hydrate workspace session:', error)
        if (!cancelled) {
          hydratePersistedUI({
            lastActiveRepoId: null,
            lastActiveWorktreeId: null,
            sidebarWidth: 280,
            groupBy: 'none',
            sortBy: 'name',
            uiZoomLevel: 0
          })
          hydrateWorkspaceSession({
            activeRepoId: null,
            activeWorktreeId: null,
            activeTabId: null,
            tabsByWorktree: {},
            terminalLayoutsByTabId: {}
          })
        }
      }
      void fetchSettings()
      void initGitHubCache()
    })()

    return () => {
      cancelled = true
    }
  }, [
    fetchRepos,
    fetchAllWorktrees,
    fetchSettings,
    initGitHubCache,
    hydratePersistedUI,
    hydrateWorkspaceSession
  ])

  // Apply theme to document
  useEffect(() => {
    if (!settings) return

    const applyTheme = (dark: boolean): void => {
      document.documentElement.classList.toggle('dark', dark)
    }

    if (settings.theme === 'dark') {
      applyTheme(true)
      return
    } else if (settings.theme === 'light') {
      applyTheme(false)
      return
    } else {
      // system
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      applyTheme(mq.matches)
      const handler = (e: MediaQueryListEvent): void => applyTheme(e.matches)
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    }
  }, [settings?.theme])

  const tabs = activeWorktreeId ? (tabsByWorktree[activeWorktreeId] ?? []) : []
  const hasTabBar = tabs.length >= 2
  const effectiveActiveTabId = activeTabId ?? tabs[0]?.id ?? null
  const activeTabCanExpand = effectiveActiveTabId
    ? (canExpandPaneByTabId[effectiveActiveTabId] ?? false)
    : false
  const effectiveActiveTabExpanded = effectiveActiveTabId
    ? (expandedPaneByTabId[effectiveActiveTabId] ?? false)
    : false
  const showTitlebarExpandButton =
    activeView !== 'settings' &&
    activeWorktreeId !== null &&
    !hasTabBar &&
    effectiveActiveTabExpanded
  const showSidebar = activeView !== 'settings'

  const handleToggleExpand = (): void => {
    if (!effectiveActiveTabId) return
    window.dispatchEvent(
      new CustomEvent(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, {
        detail: { tabId: effectiveActiveTabId }
      })
    )
  }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.repeat) return
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      if (e.key.toLowerCase() !== 'n') return
      if (repos.length === 0) return
      e.preventDefault()
      openModal('create-worktree')
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [openModal, repos.length])

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden">
      <div className="titlebar">
        <div className="titlebar-traffic-light-pad" />
        <button
          className="sidebar-toggle"
          onClick={toggleSidebar}
          title={showSidebar ? 'Toggle sidebar' : 'Sidebar unavailable in settings'}
          aria-label={showSidebar ? 'Toggle sidebar' : 'Sidebar unavailable in settings'}
          disabled={!showSidebar}
        >
          <PanelLeft size={16} />
        </button>
        <div className="titlebar-title">Orca</div>
        <div className="titlebar-spacer" />
        {showTitlebarExpandButton && (
          <button
            className="titlebar-icon-button"
            onClick={handleToggleExpand}
            title="Collapse pane"
            aria-label="Collapse pane"
            disabled={!activeTabCanExpand}
          >
            <Minimize2 size={14} />
          </button>
        )}
      </div>
      <div className="flex flex-row flex-1 min-h-0 overflow-hidden">
        {showSidebar ? <Sidebar /> : null}
        <div className="relative flex flex-1 min-w-0 min-h-0 overflow-hidden">
          {activeWorktreeId && (
            <div
              className={
                activeView === 'settings'
                  ? 'hidden flex-1 min-w-0 min-h-0'
                  : 'flex flex-1 min-w-0 min-h-0'
              }
            >
              <Terminal />
            </div>
          )}
          {activeView === 'settings' ? <Settings /> : !activeWorktreeId ? <Landing /> : null}
        </div>
      </div>
      <Toaster
        theme="system"
        position="bottom-right"
        toastOptions={{ className: 'font-sans text-sm' }}
      />
    </div>
  )
}

export default App
