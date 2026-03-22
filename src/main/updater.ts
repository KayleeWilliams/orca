import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { is } from '@electron-toolkit/utils'
import type { UpdateStatus } from '../shared/types'

let mainWindowRef: BrowserWindow | null = null
let currentStatus: UpdateStatus = { state: 'idle' }
let userInitiatedCheck = false

function sendStatus(status: UpdateStatus): void {
  currentStatus = status
  mainWindowRef?.webContents.send('updater:status', status)
}

export function getUpdateStatus(): UpdateStatus {
  return currentStatus
}

export function checkForUpdates(): void {
  if (!app.isPackaged || is.dev) {
    sendStatus({ state: 'not-available' })
    return
  }
  sendStatus({ state: 'checking' })
  autoUpdater.checkForUpdates().catch((err) => {
    sendStatus({ state: 'error', message: String(err?.message ?? err) })
  })
}

/** Menu-triggered check — delegates feedback to renderer toasts via userInitiated flag */
export function checkForUpdatesFromMenu(): void {
  if (!app.isPackaged || is.dev) {
    sendStatus({ state: 'not-available', userInitiated: true })
    return
  }

  userInitiatedCheck = true
  sendStatus({ state: 'checking', userInitiated: true })

  autoUpdater.checkForUpdates().catch((err) => {
    userInitiatedCheck = false
    sendStatus({ state: 'error', message: String(err?.message ?? err), userInitiated: true })
  })
}

export function quitAndInstall(): void {
  // Graceful shutdown: close all windows before letting the updater restart.
  // This prevents macOS from showing "quit unexpectedly" dialogs because
  // autoUpdater.quitAndInstall() calls app.exit() which bypasses lifecycle.
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.removeAllListeners('close')
    win.destroy()
  }

  setImmediate(() => {
    autoUpdater.quitAndInstall(false, true)
  })
}

export function setupAutoUpdater(mainWindow: BrowserWindow): void {
  mainWindowRef = mainWindow

  if (!app.isPackaged && !is.dev) return
  if (is.dev) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  // Use allowPrerelease to bypass broken /releases/latest endpoint (returns 406)
  // and instead parse the version directly from the atom feed which works reliably.
  // This is safe since we don't publish prerelease versions.
  autoUpdater.allowPrerelease = true

  autoUpdater.on('checking-for-update', () => {
    sendStatus({ state: 'checking', userInitiated: userInitiatedCheck || undefined })
  })

  autoUpdater.on('update-available', (info) => {
    userInitiatedCheck = false
    sendStatus({ state: 'available', version: info.version })
  })

  autoUpdater.on('update-not-available', () => {
    const wasUserInitiated = userInitiatedCheck
    userInitiatedCheck = false
    sendStatus({ state: 'not-available', userInitiated: wasUserInitiated || undefined })
  })

  autoUpdater.on('download-progress', (progress) => {
    sendStatus({ state: 'downloading', percent: Math.round(progress.percent) })
  })

  autoUpdater.on('update-downloaded', (info) => {
    sendStatus({ state: 'downloaded', version: info.version })
  })

  autoUpdater.on('error', (err) => {
    const wasUserInitiated = userInitiatedCheck
    userInitiatedCheck = false
    sendStatus({
      state: 'error',
      message: err?.message ?? 'Unknown error',
      userInitiated: wasUserInitiated || undefined
    })
  })

  autoUpdater.checkForUpdatesAndNotify()
}
