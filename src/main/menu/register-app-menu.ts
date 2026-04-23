import { BrowserWindow, Menu, app } from 'electron'

type RegisterAppMenuOptions = {
  onOpenSettings: () => void
  onCheckForUpdates: (options: { includePrerelease: boolean }) => void
  onZoomIn: () => void
  onZoomOut: () => void
  onZoomReset: () => void
  onToggleStatusBar: () => void
}

export function registerAppMenu({
  onOpenSettings,
  onCheckForUpdates,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onToggleStatusBar
}: RegisterAppMenuOptions): void {
  const reloadFocusedWindow = (ignoreCache: boolean): void => {
    const webContents = BrowserWindow.getFocusedWindow()?.webContents
    if (!webContents) {
      return
    }

    if (ignoreCache) {
      webContents.reloadIgnoringCache()
      return
    }

    webContents.reload()
  }

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        {
          label: 'Check for Updates...',
          // Why: holding Shift while clicking opts this check into the
          // release-candidate channel. The event carries the modifier keys
          // down from the native menu — we only act on the mouse chord, not
          // accelerator-triggered invocations (there is no accelerator on
          // this item, so triggeredByAccelerator should always be false here,
          // but guarding makes the intent explicit).
          click: (_menuItem, _window, event) => {
            const includePrerelease = !event.triggeredByAccelerator && event.shiftKey === true
            onCheckForUpdates({ includePrerelease })
          }
        },
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => onOpenSettings()
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'Export as PDF...',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: () => {
            // Why: fire a one-way event into the focused renderer. The renderer
            // owns the knowledge of whether a markdown surface is active and
            // what DOM to extract — when no markdown surface is active this is
            // a silent no-op on that side (see design doc §4 "Renderer UI
            // trigger"). Keeping this as a send (not an invoke) avoids main
            // needing to reason about surface state. Using
            // BrowserWindow.getFocusedWindow() rather than the menu's
            // focusedWindow param avoids the BaseWindow typing gap.
            BrowserWindow.getFocusedWindow()?.webContents.send('export:requestPdf')
          }
        }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload',
          click: () => reloadFocusedWindow(false)
        },
        {
          label: 'Force Reload',
          accelerator: 'Shift+CmdOrCtrl+R',
          click: () => reloadFocusedWindow(true)
        },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        {
          label: 'Reset Size',
          accelerator: 'CmdOrCtrl+0',
          // Why: Some keyboard layouts/platforms intercept Cmd/Ctrl+zoom chords
          // before before-input-event fires. Binding the menu accelerator gives
          // us a reliable cross-platform fallback path.
          click: () => onZoomReset()
        },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+=',
          click: () => onZoomIn()
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: () => onZoomOut()
        },
        {
          label: 'Zoom Out (Shift Alias)',
          // Why: Some Linux keyboard layouts report the top-row minus chord as
          // an underscore accelerator. Keep this hidden alias so Ctrl+- and
          // Ctrl+_ can both route to terminal zoom out.
          accelerator: 'CmdOrCtrl+_',
          visible: false,
          click: () => onZoomOut()
        },
        { type: 'separator' },
        {
          // Why: display-only shortcut hint — do NOT set `accelerator` here.
          // Menu accelerators intercept key events at the main-process level
          // before the renderer's keydown handler fires. The overlay
          // mutual-exclusion logic (which runs in the renderer) would be
          // bypassed if this were a real accelerator binding.
          label: `Open Worktree Palette\t${process.platform === 'darwin' ? 'Cmd+J' : 'Ctrl+Shift+J'}`
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        {
          label: 'Toggle Status Bar',
          click: () => onToggleStatusBar()
        }
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
