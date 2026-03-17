import { useEffect } from 'react'
import { useAppStore } from './store'
import { useIpcEvents } from './hooks/useIpcEvents'
import Sidebar from './components/Sidebar'
import Terminal from './components/Terminal'
import Landing from './components/Landing'
import Settings from './components/Settings'

function App(): React.JSX.Element {
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const activeView = useAppStore((s) => s.activeView)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const fetchRepos = useAppStore((s) => s.fetchRepos)
  const fetchSettings = useAppStore((s) => s.fetchSettings)
  const initGitHubCache = useAppStore((s) => s.initGitHubCache)

  // Subscribe to IPC push events
  useIpcEvents()

  const settings = useAppStore((s) => s.settings)

  // Fetch initial data + hydrate GitHub cache from disk
  useEffect(() => {
    fetchRepos()
    fetchSettings()
    initGitHubCache()
  }, [fetchRepos, fetchSettings, initGitHubCache])

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

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden">
      <div className="titlebar">
        <div className="titlebar-traffic-light-pad" />
        <button className="sidebar-toggle" onClick={toggleSidebar} title="Toggle sidebar">
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <line x1="2" y1="4" x2="14" y2="4" />
            <line x1="2" y1="8" x2="14" y2="8" />
            <line x1="2" y1="12" x2="14" y2="12" />
          </svg>
        </button>
        <div className="titlebar-title">Orca</div>
        <div className="titlebar-spacer" />
      </div>
      <div className="flex flex-row flex-1 min-h-0 overflow-hidden">
        <Sidebar />
        {activeView === 'settings' ? <Settings /> : activeWorktreeId ? <Terminal /> : <Landing />}
      </div>
    </div>
  )
}

export default App
