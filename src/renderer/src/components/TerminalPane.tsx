import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties } from 'react'
import type { ITheme } from '@xterm/xterm'
import {
  Clipboard,
  Copy,
  Eraser,
  Maximize2,
  Minimize2,
  PanelBottomOpen,
  PanelRightOpen,
  X
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { TOGGLE_TERMINAL_PANE_EXPAND_EVENT } from '@/constants/terminal'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalPaneSplitDirection
} from '../../../shared/types'
import { useAppStore } from '../store'
import {
  DEFAULT_TERMINAL_DIVIDER_DARK,
  getCursorStyleSequence,
  getBuiltinTheme,
  normalizeColor,
  resolvePaneStyleOptions,
  resolveEffectiveTerminalAppearance
} from '@/lib/terminal-theme'
import { PaneManager, type ManagedPane } from '@/lib/pane-manager'
import TerminalSearch from '@/components/TerminalSearch'

type PtyTransport = {
  connect: (options: {
    url: string
    cols?: number
    rows?: number
    callbacks: {
      onConnect?: () => void
      onDisconnect?: () => void
      onData?: (data: string) => void
      onStatus?: (shell: string) => void
      onError?: (message: string, errors?: string[]) => void
      onExit?: (code: number) => void
    }
  }) => void | Promise<void>
  disconnect: () => void
  sendInput: (data: string) => boolean
  resize: (
    cols: number,
    rows: number,
    meta?: { widthPx?: number; heightPx?: number; cellW?: number; cellH?: number }
  ) => boolean
  isConnected: () => boolean
  destroy?: () => void | Promise<void>
}

// Singleton PTY event dispatcher — one global IPC listener per channel,
// routes events to transports by PTY ID. Eliminates the N-listener problem
// that triggers MaxListenersExceededWarning with many panes/tabs.
const ptyDataHandlers = new Map<string, (data: string) => void>()
const ptyExitHandlers = new Map<string, (code: number) => void>()
let ptyDispatcherAttached = false

function ensurePtyDispatcher(): void {
  if (ptyDispatcherAttached) return
  ptyDispatcherAttached = true
  window.api.pty.onData((payload) => {
    ptyDataHandlers.get(payload.id)?.(payload.data)
  })
  window.api.pty.onExit((payload) => {
    ptyExitHandlers.get(payload.id)?.(payload.code)
  })
}

const CLOSE_ALL_CONTEXT_MENUS_EVENT = 'orca-close-all-context-menus'
const EMPTY_LAYOUT: TerminalLayoutSnapshot = {
  root: null,
  activeLeafId: null,
  expandedLeafId: null
}

const OSC_TITLE_RE = /\x1b\]([012]);([^\x07\x1b]*?)(?:\x07|\x1b\\)/g

function extractLastOscTitle(data: string): string | null {
  let last: string | null = null
  let m: RegExpExecArray | null
  OSC_TITLE_RE.lastIndex = 0
  while ((m = OSC_TITLE_RE.exec(data)) !== null) {
    last = m[2]
  }
  return last
}

function createIpcPtyTransport(
  cwd?: string,
  onPtyExit?: (ptyId: string) => void,
  onTitleChange?: (title: string) => void,
  onPtySpawn?: (ptyId: string) => void,
  onBell?: () => void
): PtyTransport {
  let connected = false
  let destroyed = false
  let ptyId: string | null = null
  let pendingEscape = false
  let inOsc = false
  let pendingOscEscape = false
  let storedCallbacks: {
    onConnect?: () => void
    onDisconnect?: () => void
    onData?: (data: string) => void
    onStatus?: (shell: string) => void
    onError?: (message: string, errors?: string[]) => void
    onExit?: (code: number) => void
  } = {}

  function unregisterPtyHandlers(id: string): void {
    ptyDataHandlers.delete(id)
    ptyExitHandlers.delete(id)
  }

  return {
    async connect(options) {
      storedCallbacks = options.callbacks
      ensurePtyDispatcher()

      try {
        const result = await window.api.pty.spawn({
          cols: options.cols ?? 80,
          rows: options.rows ?? 24,
          cwd
        })

        // If destroyed while spawn was in flight, kill the new pty and bail
        if (destroyed) {
          window.api.pty.kill(result.id)
          return
        }

        ptyId = result.id
        connected = true
        onPtySpawn?.(result.id)

        ptyDataHandlers.set(result.id, (data) => {
          storedCallbacks.onData?.(data)
          if (onTitleChange) {
            const title = extractLastOscTitle(data)
            if (title !== null) onTitleChange(title)
          }
          if (onBell && chunkContainsBell(data)) {
            onBell()
          }
        })

        const spawnedId = result.id
        ptyExitHandlers.set(spawnedId, (code) => {
          connected = false
          ptyId = null
          unregisterPtyHandlers(spawnedId)
          storedCallbacks.onExit?.(code)
          storedCallbacks.onDisconnect?.()
          onPtyExit?.(spawnedId)
        })

        storedCallbacks.onConnect?.()
        storedCallbacks.onStatus?.('shell')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        storedCallbacks.onError?.(msg)
      }
    },

    disconnect() {
      if (ptyId) {
        const id = ptyId
        window.api.pty.kill(id)
        connected = false
        ptyId = null
        unregisterPtyHandlers(id)
        storedCallbacks.onDisconnect?.()
      }
    },

    sendInput(data: string): boolean {
      if (!connected || !ptyId) return false
      window.api.pty.write(ptyId, data)
      return true
    },

    resize(cols: number, rows: number): boolean {
      if (!connected || !ptyId) return false
      window.api.pty.resize(ptyId, cols, rows)
      return true
    },

    isConnected() {
      return connected
    },

    destroy() {
      destroyed = true
      this.disconnect()
    }
  }

  function chunkContainsBell(data: string): boolean {
    for (let i = 0; i < data.length; i += 1) {
      const char = data[i]

      if (inOsc) {
        if (pendingOscEscape) {
          pendingOscEscape = char === '\x1b'
          if (char === '\\') {
            inOsc = false
            pendingOscEscape = false
          }
          continue
        }

        if (char === '\x07') {
          inOsc = false
          continue
        }

        pendingOscEscape = char === '\x1b'
        continue
      }

      if (pendingEscape) {
        pendingEscape = false
        if (char === ']') {
          inOsc = true
          pendingOscEscape = false
        } else if (char === '\x1b') {
          pendingEscape = true
        }
        continue
      }

      if (char === '\x1b') {
        pendingEscape = true
        continue
      }

      if (char === '\x07') return true
    }

    return false
  }
}

function paneLeafId(paneId: number): string {
  return `pane:${paneId}`
}

function buildFontFamily(fontFamily: string): string {
  const trimmed = fontFamily.trim()
  const parts = trimmed ? [`"${trimmed}"`] : []
  // Always include fallbacks
  if (!parts.some((p) => p.toLowerCase().includes('sf mono'))) {
    parts.push('"SF Mono"')
  }
  parts.push('Menlo', 'monospace')
  return parts.join(', ')
}

function getLayoutChildNodes(split: HTMLElement): HTMLElement[] {
  return Array.from(split.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement &&
      (child.classList.contains('pane') || child.classList.contains('pane-split'))
  )
}

function serializePaneTree(node: HTMLElement | null): TerminalPaneLayoutNode | null {
  if (!node) return null

  if (node.classList.contains('pane')) {
    const paneId = Number(node.dataset.paneId ?? '')
    if (!Number.isFinite(paneId)) return null
    return { type: 'leaf', leafId: paneLeafId(paneId) }
  }

  if (!node.classList.contains('pane-split')) return null
  const [first, second] = getLayoutChildNodes(node)
  const firstNode = serializePaneTree(first ?? null)
  const secondNode = serializePaneTree(second ?? null)
  if (!firstNode || !secondNode) return null

  // Capture the flex ratio so resized panes survive serialization round-trips.
  // We read the computed flex-grow values to derive the first-child proportion.
  let ratio: number | undefined
  if (first && second) {
    const firstGrow = parseFloat(first.style.flex) || 1
    const secondGrow = parseFloat(second.style.flex) || 1
    const total = firstGrow + secondGrow
    if (total > 0) {
      const r = firstGrow / total
      // Only store if meaningfully different from 0.5 (default equal split)
      if (Math.abs(r - 0.5) > 0.005) {
        ratio = Math.round(r * 1000) / 1000
      }
    }
  }

  return {
    type: 'split',
    direction: node.classList.contains('is-horizontal') ? 'horizontal' : 'vertical',
    first: firstNode,
    second: secondNode,
    ...(ratio !== undefined && { ratio })
  }
}

function serializeTerminalLayout(
  root: HTMLDivElement | null,
  activePaneId: number | null,
  expandedPaneId: number | null
): TerminalLayoutSnapshot {
  const rootNode = serializePaneTree(
    root?.firstElementChild instanceof HTMLElement ? root.firstElementChild : null
  )
  return {
    root: rootNode,
    activeLeafId: activePaneId === null ? null : paneLeafId(activePaneId),
    expandedLeafId: expandedPaneId === null ? null : paneLeafId(expandedPaneId)
  }
}

function replayTerminalLayout(
  manager: PaneManager,
  snapshot: TerminalLayoutSnapshot | null | undefined,
  focusInitialPane: boolean
): Map<string, number> {
  const paneByLeafId = new Map<string, number>()

  const initialPane = manager.createInitialPane({ focus: focusInitialPane })
  if (!snapshot?.root) {
    paneByLeafId.set(paneLeafId(initialPane.id), initialPane.id)
    return paneByLeafId
  }

  const restoreNode = (node: TerminalPaneLayoutNode, paneId: number): void => {
    if (node.type === 'leaf') {
      paneByLeafId.set(node.leafId, paneId)
      return
    }

    const createdPane = manager.splitPane(paneId, node.direction as TerminalPaneSplitDirection, {
      ratio: node.ratio
    })
    if (!createdPane) {
      collectLeafIds(node, paneByLeafId, paneId)
      return
    }

    restoreNode(node.first, paneId)
    restoreNode(node.second, createdPane.id)
  }

  restoreNode(snapshot.root, initialPane.id)
  return paneByLeafId
}

function collectLeafIds(
  node: TerminalPaneLayoutNode,
  paneByLeafId: Map<string, number>,
  paneId: number
): void {
  if (node.type === 'leaf') {
    paneByLeafId.set(node.leafId, paneId)
    return
  }
  collectLeafIds(node.first, paneByLeafId, paneId)
  collectLeafIds(node.second, paneByLeafId, paneId)
}

interface TerminalPaneProps {
  tabId: string
  worktreeId: string
  cwd?: string
  isActive: boolean
  onPtyExit: (ptyId: string) => void
}

export default function TerminalPane({
  tabId,
  worktreeId,
  cwd,
  isActive,
  onPtyExit
}: TerminalPaneProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const managerRef = useRef<PaneManager | null>(null)
  const contextPaneIdRef = useRef<number | null>(null)
  const wasActiveRef = useRef(false)
  const paneFontSizesRef = useRef<Map<number, number>>(new Map())
  const expandedPaneIdRef = useRef<number | null>(null)
  const expandedStyleSnapshotRef = useRef<Map<HTMLElement, { display: string; flex: string }>>(
    new Map()
  )
  // Track transports per pane for PTY communication
  const paneTransportsRef = useRef<Map<number, PtyTransport>>(new Map())
  // Buffer PTY data for background (non-visible) terminals to avoid
  // unnecessary parser/render work. Flushed when the tab becomes active.
  const pendingWritesRef = useRef<Map<number, string>>(new Map())
  const isActiveRef = useRef(isActive)
  isActiveRef.current = isActive
  const [terminalMenuOpen, setTerminalMenuOpen] = useState(false)
  const [terminalMenuPoint, setTerminalMenuPoint] = useState({ x: 0, y: 0 })
  const menuOpenedAtRef = useRef(0)
  const [expandedPaneId, setExpandedPaneId] = useState<number | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const setTabPaneExpanded = useAppStore((s) => s.setTabPaneExpanded)
  const setTabCanExpandPane = useAppStore((s) => s.setTabCanExpandPane)
  const savedLayout = useAppStore((s) => s.terminalLayoutsByTabId[tabId] ?? EMPTY_LAYOUT)
  const setTabLayout = useAppStore((s) => s.setTabLayout)
  const initialLayoutRef = useRef(savedLayout)

  const persistLayoutSnapshot = (): void => {
    const manager = managerRef.current
    const container = containerRef.current
    if (!manager || !container) return
    const activePaneId = manager.getActivePane()?.id ?? manager.getPanes()[0]?.id ?? null
    setTabLayout(tabId, serializeTerminalLayout(container, activePaneId, expandedPaneIdRef.current))
  }

  const setExpandedPane = (paneId: number | null): void => {
    expandedPaneIdRef.current = paneId
    setExpandedPaneId(paneId)
    setTabPaneExpanded(tabId, paneId !== null)
    persistLayoutSnapshot()
  }

  const rememberPaneStyle = (
    snapshots: Map<HTMLElement, { display: string; flex: string }>,
    el: HTMLElement
  ): void => {
    if (snapshots.has(el)) return
    snapshots.set(el, { display: el.style.display, flex: el.style.flex })
  }

  const restoreExpandedLayout = (): void => {
    const snapshots = expandedStyleSnapshotRef.current
    for (const [el, prev] of snapshots.entries()) {
      el.style.display = prev.display
      el.style.flex = prev.flex
    }
    snapshots.clear()
  }

  const applyExpandedLayout = (paneId: number): boolean => {
    const manager = managerRef.current
    const root = containerRef.current
    if (!manager || !root) return false

    const panes = manager.getPanes()
    if (panes.length <= 1) return false
    const targetPane = panes.find((pane) => pane.id === paneId)
    if (!targetPane) return false

    restoreExpandedLayout()
    const snapshots = expandedStyleSnapshotRef.current
    let current: HTMLElement | null = targetPane.container
    while (current && current !== root) {
      const parent = current.parentElement
      if (!parent) break
      for (const child of Array.from(parent.children)) {
        if (!(child instanceof HTMLElement)) continue
        rememberPaneStyle(snapshots, child)
        if (child === current) {
          child.style.display = ''
          child.style.flex = '1 1 auto'
        } else {
          child.style.display = 'none'
        }
      }
      current = parent
    }
    return true
  }

  const refreshPaneSizes = (focusActive: boolean): void => {
    requestAnimationFrame(() => {
      const manager = managerRef.current
      if (!manager) return
      const panes = manager.getPanes()
      for (const p of panes) {
        try {
          p.fitAddon.fit()
        } catch {
          /* container may not have dimensions */
        }
      }
      if (focusActive) {
        const active = manager.getActivePane() ?? panes[0]
        active?.terminal.focus()
      }
    })
  }

  const syncExpandedLayout = (): void => {
    const paneId = expandedPaneIdRef.current
    if (paneId === null) {
      restoreExpandedLayout()
      return
    }

    const manager = managerRef.current
    if (!manager) return
    const panes = manager.getPanes()
    if (panes.length <= 1 || !panes.some((pane) => pane.id === paneId)) {
      setExpandedPane(null)
      restoreExpandedLayout()
      return
    }
    applyExpandedLayout(paneId)
  }

  const syncCanExpandState = (): void => {
    const paneCount = managerRef.current?.getPanes().length ?? 1
    setTabCanExpandPane(tabId, paneCount > 1)
  }

  const toggleExpandPane = (paneId: number): void => {
    const manager = managerRef.current
    if (!manager) return
    const panes = manager.getPanes()
    if (panes.length <= 1) return

    const isAlreadyExpanded = expandedPaneIdRef.current === paneId
    if (isAlreadyExpanded) {
      setExpandedPane(null)
      restoreExpandedLayout()
      refreshPaneSizes(true)
      persistLayoutSnapshot()
      return
    }

    setExpandedPane(paneId)
    if (!applyExpandedLayout(paneId)) {
      setExpandedPane(null)
      restoreExpandedLayout()
      persistLayoutSnapshot()
      return
    }
    manager.setActivePane(paneId, { focus: true })
    refreshPaneSizes(true)
    persistLayoutSnapshot()
  }

  useEffect(() => {
    const closeMenu = (): void => {
      // Skip if we just opened (same frame / same event cycle)
      if (Date.now() - menuOpenedAtRef.current < 100) return
      setTerminalMenuOpen(false)
    }
    window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
    return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
  }, [])

  const updateTabTitle = useAppStore((s) => s.updateTabTitle)
  const updateTabPtyId = useAppStore((s) => s.updateTabPtyId)
  const clearTabPtyId = useAppStore((s) => s.clearTabPtyId)
  const markWorktreeUnreadFromBell = useAppStore((s) => s.markWorktreeUnreadFromBell)
  const settings = useAppStore((s) => s.settings)
  const [systemPrefersDark, setSystemPrefersDark] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : true
  )
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  // Use a ref so the PaneManager closure always calls the latest onPtyExit
  const onPtyExitRef = useRef(onPtyExit)
  onPtyExitRef.current = onPtyExit

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = (event: MediaQueryListEvent): void => {
      setSystemPrefersDark(event.matches)
    }
    setSystemPrefersDark(media.matches)
    media.addEventListener('change', handleChange)
    return () => media.removeEventListener('change', handleChange)
  }, [])

  const applyTerminalAppearance = (manager: PaneManager): void => {
    const currentSettings = settingsRef.current
    if (!currentSettings) return

    const appearance = resolveEffectiveTerminalAppearance(currentSettings, systemPrefersDark)
    const paneStyles = resolvePaneStyleOptions(currentSettings)
    const cursorSequence = getCursorStyleSequence(
      currentSettings.terminalCursorStyle,
      currentSettings.terminalCursorBlink
    )
    const theme: ITheme | null = appearance.theme ?? getBuiltinTheme(appearance.themeName)
    const paneBackground = theme?.background ?? '#000000'

    for (const pane of manager.getPanes()) {
      if (theme) {
        pane.terminal.options.theme = theme
      }
      pane.terminal.options.cursorStyle = currentSettings.terminalCursorStyle
      pane.terminal.options.cursorBlink = currentSettings.terminalCursorBlink
      const paneSize = paneFontSizesRef.current.get(pane.id)
      pane.terminal.options.fontSize = paneSize ?? currentSettings.terminalFontSize
      try {
        pane.fitAddon.fit()
      } catch {
        /* ignore */
      }
      // Send cursor style sequence to PTY
      const transport = paneTransportsRef.current.get(pane.id)
      transport?.sendInput(cursorSequence)
    }

    manager.setPaneStyleOptions({
      splitBackground: paneBackground,
      paneBackground,
      inactivePaneOpacity: paneStyles.inactivePaneOpacity,
      activePaneOpacity: paneStyles.activePaneOpacity,
      opacityTransitionMs: paneStyles.opacityTransitionMs,
      dividerThicknessPx: paneStyles.dividerThicknessPx
    })
  }

  // Connect a pane's terminal to a PTY via IPC transport
  const connectPanePty = (pane: ManagedPane, manager: PaneManager): void => {
    const onExit = (ptyId: string): void => {
      // Always clear the dead PTY ID from the store to avoid stale state
      clearTabPtyId(tabId, ptyId)

      const panes = manager.getPanes()
      if (panes.length <= 1) {
        onPtyExitRef.current(ptyId)
        return
      }
      manager.closePane(pane.id)
    }

    const onTitleChange = (title: string): void => {
      updateTabTitle(tabId, title)
    }

    const onPtySpawn = (ptyId: string): void => updateTabPtyId(tabId, ptyId)
    const onBell = (): void => markWorktreeUnreadFromBell(worktreeId)

    const transport = createIpcPtyTransport(cwd, onExit, onTitleChange, onPtySpawn, onBell)
    paneTransportsRef.current.set(pane.id, transport)

    // Wire terminal → PTY
    pane.terminal.onData((data) => {
      transport.sendInput(data)
    })

    // Wire terminal resize → PTY resize
    pane.terminal.onResize(({ cols, rows }) => {
      transport.resize(cols, rows)
    })

    // Defer PTY spawn to next frame so FitAddon has time to calculate
    // the correct terminal dimensions from the laid-out container. Without
    // this, the PTY is spawned with the default 80×24 and never resized
    // to fill the actual container.
    pendingWritesRef.current.set(pane.id, '')
    requestAnimationFrame(() => {
      // Fit first so cols/rows reflect the real container size
      try {
        pane.fitAddon.fit()
      } catch {
        /* ignore */
      }
      const cols = pane.terminal.cols
      const rows = pane.terminal.rows
      transport.connect({
        url: '',
        cols,
        rows,
        callbacks: {
          onData: (data) => {
            if (isActiveRef.current) {
              // Visible — write immediately for responsive output
              pane.terminal.write(data)
            } else {
              // Hidden — buffer data to avoid unnecessary render work.
              // The buffer is flushed in one write() call when the tab
              // becomes visible, which is much cheaper than N small writes.
              const pending = pendingWritesRef.current
              pending.set(pane.id, (pending.get(pane.id) ?? '') + data)
            }
          }
        }
      })
    })
  }

  // Initialize PaneManager instance once
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let resizeRaf: number | null = null

    const queueResizeAll = (focusActive: boolean): void => {
      if (resizeRaf !== null) cancelAnimationFrame(resizeRaf)
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = null
        const manager = managerRef.current
        if (!manager) return
        const panes = manager.getPanes()
        for (const p of panes) {
          try {
            p.fitAddon.fit()
          } catch {
            /* ignore */
          }
        }
        if (focusActive) {
          const active = manager.getActivePane() ?? panes[0]
          active?.terminal.focus()
        }
      })
    }

    let shouldPersistLayout = false

    const manager = new PaneManager(container, {
      onPaneCreated: (pane) => {
        // Apply appearance before connecting PTY
        applyTerminalAppearance(manager)
        // Connect PTY
        connectPanePty(pane, manager)
        queueResizeAll(true)
      },
      onPaneClosed: (paneId) => {
        // Clean up transport for closed pane
        const transport = paneTransportsRef.current.get(paneId)
        if (transport) {
          transport.destroy?.()
          paneTransportsRef.current.delete(paneId)
        }
        paneFontSizesRef.current.delete(paneId)
        pendingWritesRef.current.delete(paneId)
      },
      onActivePaneChange: () => {
        if (shouldPersistLayout) persistLayoutSnapshot()
      },
      onLayoutChanged: () => {
        syncExpandedLayout()
        syncCanExpandState()
        queueResizeAll(false)
        if (shouldPersistLayout) persistLayoutSnapshot()
      },
      terminalOptions: () => {
        const currentSettings = settingsRef.current
        return {
          fontSize: currentSettings?.terminalFontSize ?? 14,
          fontFamily: buildFontFamily(currentSettings?.terminalFontFamily ?? 'SF Mono'),
          // Convert byte budget to line count. ~200 bytes/line is a reasonable
          // average for typical terminal output (columns × ~2 bytes + overhead).
          // Default 10MB → ~50K lines; cap at 50K to keep memory reasonable.
          scrollback: Math.min(
            50_000,
            Math.max(
              1000,
              Math.round((currentSettings?.terminalScrollbackBytes ?? 10_000_000) / 200)
            )
          ),
          cursorStyle: currentSettings?.terminalCursorStyle ?? 'bar',
          cursorBlink: currentSettings?.terminalCursorBlink ?? true
        }
      },
      onLinkClick: (url) => {
        window.api.shell.openExternal(url)
      }
    })

    managerRef.current = manager
    const restoredPaneByLeafId = replayTerminalLayout(manager, initialLayoutRef.current, isActive)
    const restoredActivePaneId =
      (initialLayoutRef.current.activeLeafId
        ? restoredPaneByLeafId.get(initialLayoutRef.current.activeLeafId)
        : null) ??
      manager.getActivePane()?.id ??
      manager.getPanes()[0]?.id ??
      null
    if (restoredActivePaneId !== null) {
      manager.setActivePane(restoredActivePaneId, { focus: isActive })
    }
    const restoredExpandedPaneId = initialLayoutRef.current.expandedLeafId
      ? (restoredPaneByLeafId.get(initialLayoutRef.current.expandedLeafId) ?? null)
      : null
    if (restoredExpandedPaneId !== null && manager.getPanes().length > 1) {
      setExpandedPane(restoredExpandedPaneId)
      applyExpandedLayout(restoredExpandedPaneId)
    } else {
      setExpandedPane(null)
    }
    shouldPersistLayout = true
    syncCanExpandState()
    applyTerminalAppearance(manager)
    queueResizeAll(isActive)
    persistLayoutSnapshot()

    return () => {
      if (resizeRaf !== null) cancelAnimationFrame(resizeRaf)
      restoreExpandedLayout()
      // Destroy all transports
      for (const transport of paneTransportsRef.current.values()) {
        transport.destroy?.()
      }
      paneTransportsRef.current.clear()
      pendingWritesRef.current.clear()
      manager.destroy()
      managerRef.current = null
      setTabPaneExpanded(tabId, false)
      setTabCanExpandPane(tabId, false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, cwd])

  useEffect(() => {
    const manager = managerRef.current
    if (!manager || !settings) return
    applyTerminalAppearance(manager)
    // Update font family on all panes
    const fontFamily = buildFontFamily(settings.terminalFontFamily)
    for (const pane of manager.getPanes()) {
      pane.terminal.options.fontFamily = fontFamily
      try {
        pane.fitAddon.fit()
      } catch {
        /* ignore */
      }
    }
  }, [settings, systemPrefersDark])

  // Per-pane font zoom via Cmd+Plus/Minus/0
  useEffect(() => {
    if (!isActive) return
    const MIN_FONT_SIZE = 8
    const MAX_FONT_SIZE = 32
    const FONT_SIZE_STEP = 1

    return window.api.ui.onTerminalZoom((direction) => {
      const manager = managerRef.current
      if (!manager) return
      const pane = manager.getActivePane()
      if (!pane) return

      const globalSize = settingsRef.current?.terminalFontSize ?? 14
      const currentSize = paneFontSizesRef.current.get(pane.id) ?? globalSize

      let nextSize: number
      if (direction === 'reset') {
        nextSize = globalSize
        paneFontSizesRef.current.delete(pane.id)
      } else if (direction === 'in') {
        nextSize = Math.min(MAX_FONT_SIZE, currentSize + FONT_SIZE_STEP)
        paneFontSizesRef.current.set(pane.id, nextSize)
      } else {
        nextSize = Math.max(MIN_FONT_SIZE, currentSize - FONT_SIZE_STEP)
        paneFontSizesRef.current.set(pane.id, nextSize)
      }

      pane.terminal.options.fontSize = nextSize
      try {
        pane.fitAddon.fit()
      } catch {
        /* ignore */
      }
    })
  }, [isActive])

  // Handle focus, resize, and WebGL suspend/resume when tab becomes active/inactive
  useEffect(() => {
    const manager = managerRef.current
    if (!manager) return

    if (isActive) {
      // Resume GPU rendering — recreate WebGL addons that were disposed
      manager.resumeRendering()

      // Flush any buffered PTY data that arrived while hidden
      for (const [paneId, buf] of pendingWritesRef.current.entries()) {
        if (buf.length > 0) {
          const pane = manager.getPanes().find((p) => p.id === paneId)
          if (pane) pane.terminal.write(buf)
          pendingWritesRef.current.set(paneId, '')
        }
      }

      // Ensure size/focus is correct both on initial mount and tab activation.
      requestAnimationFrame(() => {
        const panes = manager.getPanes()
        for (const p of panes) {
          try {
            p.fitAddon.fit()
          } catch {
            /* ignore */
          }
        }
        const active = manager.getActivePane() ?? panes[0]
        if (active) {
          active.terminal.focus()
        }
      })
    } else if (wasActiveRef.current) {
      // Went from active → inactive: free GPU contexts
      manager.suspendRendering()
    }
    wasActiveRef.current = isActive
  }, [isActive])

  useEffect(() => {
    const onToggleExpand = (event: Event): void => {
      const detail = (event as CustomEvent<{ tabId?: string }>).detail
      if (!detail?.tabId || detail.tabId !== tabId) return
      const manager = managerRef.current
      if (!manager) return
      const panes = manager.getPanes()
      if (panes.length < 2) return
      const pane = manager.getActivePane() ?? panes[0]
      if (!pane) return
      toggleExpandPane(pane.id)
    }

    window.addEventListener(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, onToggleExpand)
    return () => window.removeEventListener(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, onToggleExpand)
  }, [tabId])

  // ResizeObserver to keep terminal sized to container
  useEffect(() => {
    if (!isActive) return

    const container = containerRef.current
    if (!container) return

    const ro = new ResizeObserver(() => {
      const manager = managerRef.current
      if (!manager) return
      const panes = manager.getPanes()
      for (const p of panes) {
        try {
          p.fitAddon.fit()
        } catch {
          /* ignore */
        }
      }
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [isActive])

  // Terminal pane shortcuts handled at window capture phase so they remain
  // reliable even when focus is inside the canvas/IME internals.
  useEffect(() => {
    if (!isActive) return

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.repeat) return
      if (!e.metaKey || e.altKey || e.ctrlKey) return

      const manager = managerRef.current
      if (!manager) return

      // Cmd+F opens search
      if (!e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        e.stopPropagation()
        setSearchOpen((prev) => !prev)
        return
      }

      // Cmd+K clears active pane screen + scrollback.
      if (!e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        e.stopPropagation()
        const pane = manager.getActivePane() ?? manager.getPanes()[0]
        if (pane) {
          pane.terminal.clear()
        }
        return
      }

      // Cmd+[ / Cmd+] cycles active split pane focus.
      if (!e.shiftKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
        const panes = manager.getPanes()
        if (panes.length < 2) return
        e.preventDefault()
        e.stopPropagation()

        // Collapse expanded pane before switching
        if (expandedPaneIdRef.current !== null) {
          setExpandedPane(null)
          restoreExpandedLayout()
          refreshPaneSizes(true)
          persistLayoutSnapshot()
        }

        const activeId = manager.getActivePane()?.id ?? panes[0].id
        const currentIdx = panes.findIndex((p) => p.id === activeId)
        if (currentIdx === -1) return

        const dir = e.code === 'BracketRight' ? 1 : -1
        const nextPane = panes[(currentIdx + dir + panes.length) % panes.length]
        manager.setActivePane(nextPane.id, { focus: true })
        return
      }

      // Cmd+Shift+Enter expands/collapses the active pane to full terminal area.
      if (e.shiftKey && e.key === 'Enter' && (e.code === 'Enter' || e.code === 'NumpadEnter')) {
        const panes = manager.getPanes()
        if (panes.length < 2) return
        e.preventDefault()
        e.stopPropagation()
        const pane = manager.getActivePane() ?? panes[0]
        if (!pane) return
        toggleExpandPane(pane.id)
        return
      }

      // Cmd+W closes only the active split pane and prevents the tab-level
      // handler from closing the entire terminal tab.
      if (!e.shiftKey && e.key.toLowerCase() === 'w') {
        const panes = manager.getPanes()
        if (panes.length < 2) return
        e.preventDefault()
        e.stopPropagation()
        const pane = manager.getActivePane() ?? panes[0]
        if (!pane) return
        manager.closePane(pane.id)
        return
      }

      // Cmd+D / Cmd+Shift+D split the active pane in the focused tab only.
      if (e.key.toLowerCase() === 'd') {
        e.preventDefault()
        e.stopPropagation()
        const pane = manager.getActivePane() ?? manager.getPanes()[0]
        if (!pane) return
        manager.splitPane(pane.id, e.shiftKey ? 'horizontal' : 'vertical')
      }
    }

    // Ctrl+Backspace → send \x17 (backward-kill-word) to PTY.
    const onCtrlBackspace = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      if (e.key !== 'Backspace') return

      const manager = managerRef.current
      if (!manager) return

      e.preventDefault()
      e.stopPropagation()
      const pane = manager.getActivePane() ?? manager.getPanes()[0]
      if (!pane) return
      const transport = paneTransportsRef.current.get(pane.id)
      transport?.sendInput('\x17')
    }

    // Alt+Backspace → send ESC + DEL (\x1b\x7f, backward-kill-word) to PTY.
    const onAltBackspace = (e: KeyboardEvent): void => {
      if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return
      if (e.key !== 'Backspace') return

      const manager = managerRef.current
      if (!manager) return

      e.preventDefault()
      e.stopPropagation()
      const pane = manager.getActivePane() ?? manager.getPanes()[0]
      if (!pane) return
      const transport = paneTransportsRef.current.get(pane.id)
      transport?.sendInput('\x1b\x7f')
    }

    // Shift+Enter → insert a literal newline into the shell command line.
    const onShiftEnter = (e: KeyboardEvent): void => {
      if (!e.shiftKey || e.metaKey || e.altKey || e.ctrlKey) return
      if (e.key !== 'Enter') return

      const manager = managerRef.current
      if (!manager) return

      e.preventDefault()
      e.stopPropagation()
      const pane = manager.getActivePane() ?? manager.getPanes()[0]
      if (!pane) return
      const transport = paneTransportsRef.current.get(pane.id)
      transport?.sendInput('\x16\x0a')
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    window.addEventListener('keydown', onCtrlBackspace, { capture: true })
    window.addEventListener('keydown', onAltBackspace, { capture: true })
    window.addEventListener('keydown', onShiftEnter, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      window.removeEventListener('keydown', onCtrlBackspace, { capture: true })
      window.removeEventListener('keydown', onAltBackspace, { capture: true })
      window.removeEventListener('keydown', onShiftEnter, { capture: true })
    }
  }, [isActive])

  const resolveMenuPane = () => {
    const manager = managerRef.current
    if (!manager) return null
    const panes = manager.getPanes()

    if (contextPaneIdRef.current !== null) {
      const clickedPane = panes.find((p) => p.id === contextPaneIdRef.current) ?? null
      if (clickedPane) return clickedPane
    }
    return manager.getActivePane() ?? panes[0] ?? null
  }

  const handleCopy = async (): Promise<void> => {
    const pane = resolveMenuPane()
    if (!pane) return
    const selection = pane.terminal.getSelection()
    if (selection) {
      await navigator.clipboard.writeText(selection)
    }
  }

  const handlePaste = async (): Promise<void> => {
    const pane = resolveMenuPane()
    if (!pane) return
    const text = await navigator.clipboard.readText()
    if (text) {
      const transport = paneTransportsRef.current.get(pane.id)
      transport?.sendInput(text)
    }
  }

  const handleSplitRight = (): void => {
    const pane = resolveMenuPane()
    if (!pane) return
    managerRef.current?.splitPane(pane.id, 'vertical')
  }

  const handleSplitDown = (): void => {
    const pane = resolveMenuPane()
    if (!pane) return
    managerRef.current?.splitPane(pane.id, 'horizontal')
  }

  const handleClosePane = (): void => {
    const pane = resolveMenuPane()
    if (!pane) return
    const panes = managerRef.current?.getPanes() ?? []
    if (panes.length <= 1) return
    managerRef.current?.closePane(pane.id)
  }

  const handleClearScreen = (): void => {
    const pane = resolveMenuPane()
    if (!pane) return
    pane.terminal.clear()
  }

  const handleToggleExpand = (): void => {
    const pane = resolveMenuPane()
    if (!pane) return
    toggleExpandPane(pane.id)
  }

  const paneCount = managerRef.current?.getPanes().length ?? 1
  const canClosePane = paneCount > 1
  const canExpandPane = paneCount > 1
  const menuPaneId = resolveMenuPane()?.id ?? null
  const menuPaneIsExpanded = menuPaneId !== null && menuPaneId === expandedPaneId
  const effectiveAppearance = settings
    ? resolveEffectiveTerminalAppearance(settings, systemPrefersDark)
    : null
  const terminalContainerStyle: CSSProperties = {
    display: isActive ? 'flex' : 'none',
    ['--orca-terminal-divider-color' as string]:
      effectiveAppearance?.dividerColor ?? DEFAULT_TERMINAL_DIVIDER_DARK,
    ['--orca-terminal-divider-color-strong' as string]: normalizeColor(
      effectiveAppearance?.dividerColor,
      DEFAULT_TERMINAL_DIVIDER_DARK
    )
  }

  // Get the search addon for the active pane and its container for portal
  const activePane = managerRef.current?.getActivePane()
  const activeSearchAddon = activePane?.searchAddon ?? null
  const activePaneContainer = activePane?.container ?? null

  // Drag & drop file paths into terminal.
  // The preload script handles dragover/drop (File.path is only available there),
  // sends paths to main process, which relays them here via IPC.
  useEffect(() => {
    if (!isActive) return

    const shellEscape = (p: string): string => {
      if (/^[a-zA-Z0-9_./@:-]+$/.test(p)) return p
      return "'" + p.replace(/'/g, "'\\''") + "'"
    }

    return window.api.ui.onFileDrop(({ path: filePath }) => {
      const manager = managerRef.current
      if (!manager) return
      const pane = manager.getActivePane() ?? manager.getPanes()[0]
      if (!pane) return
      const transport = paneTransportsRef.current.get(pane.id)
      if (!transport) return
      transport.sendInput(shellEscape(filePath))
    })
  }, [isActive])

  return (
    <>
      <div
        ref={containerRef}
        className="absolute inset-0 min-h-0 min-w-0"
        style={terminalContainerStyle}
        onContextMenuCapture={(event) => {
          event.preventDefault()
          menuOpenedAtRef.current = Date.now()
          window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))

          const manager = managerRef.current
          if (!manager) {
            contextPaneIdRef.current = null
            return
          }

          const target = event.target
          if (!(target instanceof Node)) {
            contextPaneIdRef.current = null
            return
          }
          const clickedPane =
            manager.getPanes().find((pane) => pane.container.contains(target)) ?? null
          contextPaneIdRef.current = clickedPane?.id ?? null

          const bounds = event.currentTarget.getBoundingClientRect()
          setTerminalMenuPoint({ x: event.clientX - bounds.left, y: event.clientY - bounds.top })
          setTerminalMenuOpen(true)
        }}
      />
      {activePaneContainer &&
        createPortal(
          <TerminalSearch
            isOpen={searchOpen}
            onClose={() => setSearchOpen(false)}
            searchAddon={activeSearchAddon}
          />,
          activePaneContainer
        )}
      <DropdownMenu
        open={terminalMenuOpen}
        onOpenChange={(open) => {
          if (!open && Date.now() - menuOpenedAtRef.current < 100) return
          setTerminalMenuOpen(open)
        }}
        modal={false}
      >
        <DropdownMenuTrigger asChild>
          <button
            aria-hidden
            tabIndex={-1}
            className="pointer-events-none absolute size-px opacity-0"
            style={{ left: terminalMenuPoint.x, top: terminalMenuPoint.y }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="w-48"
          sideOffset={0}
          align="start"
          onCloseAutoFocus={(e) => {
            // Prevent Radix from moving focus back to the hidden trigger;
            // let xterm keep focus naturally.
            e.preventDefault()
          }}
          onFocusOutside={(e) => {
            // xterm reclaims focus after the contextmenu event; don't let
            // Radix treat that as a dismiss signal.
            e.preventDefault()
          }}
        >
          <DropdownMenuItem onSelect={() => void handleCopy()}>
            <Copy />
            Copy
            <DropdownMenuShortcut>⌘C</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void handlePaste()}>
            <Clipboard />
            Paste
            <DropdownMenuShortcut>⌘V</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={handleSplitRight}>
            <PanelRightOpen />
            Split Right
            <DropdownMenuShortcut>⌘D</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleSplitDown}>
            <PanelBottomOpen />
            Split Down
            <DropdownMenuShortcut>⌘⇧D</DropdownMenuShortcut>
          </DropdownMenuItem>
          {canExpandPane && (
            <DropdownMenuItem onSelect={handleToggleExpand}>
              {menuPaneIsExpanded ? <Minimize2 /> : <Maximize2 />}
              {menuPaneIsExpanded ? 'Collapse Pane' : 'Expand Pane'}
              <DropdownMenuShortcut>⌘⇧↩</DropdownMenuShortcut>
            </DropdownMenuItem>
          )}
          {canClosePane && (
            <DropdownMenuItem variant="destructive" onSelect={handleClosePane}>
              <X />
              Close Pane
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={handleClearScreen}>
            <Eraser />
            Clear Screen
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
