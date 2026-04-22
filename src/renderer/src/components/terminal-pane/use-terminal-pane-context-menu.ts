import { useEffect, useRef, useState } from 'react'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'

const CLOSE_ALL_CONTEXT_MENUS_EVENT = 'orca-close-all-context-menus'

type UseTerminalPaneContextMenuDeps = {
  managerRef: React.RefObject<PaneManager | null>
  toggleExpandPane: (paneId: number) => void
  onRequestClosePane: (paneId: number) => void
  onSetTitle: (paneId: number) => void
  rightClickToPaste: boolean
  /** Populated by the OSC 7 handler in use-terminal-pane-lifecycle. `null` /
   *  missing when the shell has not emitted a cwd update, which controls
   *  whether the "Reveal in Finder" context-menu item is shown. */
  paneCwdRef: React.RefObject<Map<number, string>>
}

type TerminalMenuState = {
  open: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
  point: { x: number; y: number }
  menuOpenedAtRef: React.RefObject<number>
  paneCount: number
  menuPaneId: number | null
  /** Last OSC 7 cwd observed for the menu-target pane, or null if the shell
   *  has not emitted one. Read at menu-open time so the item reflects the
   *  pane's current directory without re-rendering on every `cd`. */
  menuPaneCwd: string | null
  onContextMenuCapture: (event: React.MouseEvent<HTMLDivElement>) => void
  onCopy: () => Promise<void>
  onPaste: () => Promise<void>
  onSplitRight: () => void
  onSplitDown: () => void
  onClosePane: () => void
  onClearScreen: () => void
  onToggleExpand: () => void
  onSetTitle: () => void
  onRevealCwd: () => void
}

export function useTerminalPaneContextMenu({
  managerRef,
  toggleExpandPane,
  onRequestClosePane,
  onSetTitle,
  rightClickToPaste,
  paneCwdRef
}: UseTerminalPaneContextMenuDeps): TerminalMenuState {
  const contextPaneIdRef = useRef<number | null>(null)
  const menuOpenedAtRef = useRef(0)
  const [open, setOpen] = useState(false)
  const [point, setPoint] = useState({ x: 0, y: 0 })

  useEffect(() => {
    const closeMenu = (): void => {
      if (Date.now() - menuOpenedAtRef.current < 100) {
        return
      }
      setOpen(false)
    }
    window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
    return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
  }, [])

  const resolveMenuPane = (): ManagedPane | null => {
    const manager = managerRef.current
    if (!manager) {
      return null
    }
    const panes = manager.getPanes()
    if (contextPaneIdRef.current !== null) {
      const clickedPane = panes.find((pane) => pane.id === contextPaneIdRef.current) ?? null
      if (clickedPane) {
        return clickedPane
      }
    }
    return manager.getActivePane() ?? panes[0] ?? null
  }

  const onCopy = async (): Promise<void> => {
    const pane = resolveMenuPane()
    if (!pane) {
      return
    }
    const selection = pane.terminal.getSelection()
    if (selection) {
      await window.api.ui.writeClipboardText(selection)
    }
    // Why: Radix returns focus to the menu trigger (the pane container) on
    // close, but xterm.js only accepts input when its own helper textarea is
    // focused. Without this, the user has to click the pane again before
    // typing works (see #592).
    pane.terminal.focus()
  }

  const onPaste = async (): Promise<void> => {
    const pane = resolveMenuPane()
    if (!pane) {
      return
    }
    const text = await window.api.ui.readClipboardText()
    if (text) {
      pane.terminal.paste(text)
      pane.terminal.focus()
      return
    }
    // Why: clipboard has no text — check for an image (e.g. screenshot).
    // Saves the image to a temp file and pastes the path so CLI tools like
    // Claude Code can access it, consistent with the keyboard paste path.
    const filePath = await window.api.ui.saveClipboardImageAsTempFile()
    if (filePath) {
      pane.terminal.paste(filePath)
    }
    // Why: Radix returns focus to the menu trigger (the pane container) on
    // close, but xterm.js only accepts input when its own helper textarea is
    // focused. Without this, the user has to click the pane again before
    // typing works (see #592).
    pane.terminal.focus()
  }

  const onSplitRight = (): void => {
    const pane = resolveMenuPane()
    if (pane) {
      managerRef.current?.splitPane(pane.id, 'vertical')
    }
  }

  const onSplitDown = (): void => {
    const pane = resolveMenuPane()
    if (pane) {
      managerRef.current?.splitPane(pane.id, 'horizontal')
    }
  }

  const onClosePane = (): void => {
    const pane = resolveMenuPane()
    if (pane && (managerRef.current?.getPanes().length ?? 0) > 1) {
      onRequestClosePane(pane.id)
    }
  }

  const onClearScreen = (): void => {
    const pane = resolveMenuPane()
    if (pane) {
      pane.terminal.clear()
    }
  }

  const onToggleExpand = (): void => {
    const pane = resolveMenuPane()
    if (pane) {
      toggleExpandPane(pane.id)
    }
  }

  const handleSetTitle = (): void => {
    const pane = resolveMenuPane()
    if (pane) {
      onSetTitle(pane.id)
    }
  }

  const onRevealCwd = (): void => {
    const pane = resolveMenuPane()
    if (!pane) {
      return
    }
    const cwd = paneCwdRef.current?.get(pane.id)
    if (!cwd) {
      return
    }
    // Why: shell.showItemInFolder() selects the *item* in its parent — passing
    // a directory path opens the parent with the dir selected, which is what
    // users want from "Reveal in Finder/Explorer" and matches native app
    // behavior on all three platforms.
    void window.api.shell.openPath(cwd)
  }

  const onContextMenuCapture = (event: React.MouseEvent<HTMLDivElement>): void => {
    event.preventDefault()
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
    const clickedPane = manager.getPanes().find((pane) => pane.container.contains(target)) ?? null
    contextPaneIdRef.current = clickedPane?.id ?? null

    // Why: Windows terminals treat right-click as copy-or-paste depending on
    // whether text is selected. With a selection, right-click copies it and
    // clears the selection; without one, it pastes. Ctrl+right-click still
    // reaches the app menu so the menu remains discoverable.
    if (rightClickToPaste && !event.ctrlKey) {
      event.stopPropagation()
      const selection = clickedPane?.terminal.getSelection()
      if (selection) {
        void window.api.ui.writeClipboardText(selection)
        clickedPane?.terminal.clearSelection()
      } else {
        void onPaste()
      }
      return
    }

    menuOpenedAtRef.current = Date.now()
    const bounds = event.currentTarget.getBoundingClientRect()
    setPoint({ x: event.clientX - bounds.left, y: event.clientY - bounds.top })
    setOpen(true)
  }

  const paneCount = managerRef.current?.getPanes().length ?? 1
  const menuPaneId = resolveMenuPane()?.id ?? null
  const menuPaneCwd = menuPaneId !== null ? (paneCwdRef.current?.get(menuPaneId) ?? null) : null

  return {
    open,
    setOpen,
    point,
    menuOpenedAtRef,
    paneCount,
    menuPaneId,
    menuPaneCwd,
    onContextMenuCapture,
    onCopy,
    onPaste,
    onSplitRight,
    onSplitDown,
    onClosePane,
    onClearScreen,
    onToggleExpand,
    onSetTitle: handleSetTitle,
    onRevealCwd
  }
}
