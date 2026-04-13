/* eslint-disable max-lines -- Why: browser IPC handlers must be registered together so the
   trust boundary (isTrustedBrowserRenderer) and handler teardown stay consistent. */
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { browserManager } from '../browser/browser-manager'
import { browserSessionRegistry } from '../browser/browser-session-registry'
import {
  pickCookieFile,
  importCookiesFromFile,
  detectInstalledBrowsers,
  importCookiesFromBrowser
} from '../browser/browser-cookie-import'
import type { DetectedBrowser } from '../browser/browser-cookie-import'
import type {
  BrowserSetGrabModeArgs,
  BrowserSetGrabModeResult,
  BrowserAwaitGrabSelectionArgs,
  BrowserGrabResult,
  BrowserCancelGrabArgs,
  BrowserCaptureSelectionScreenshotArgs,
  BrowserCaptureSelectionScreenshotResult,
  BrowserExtractHoverArgs,
  BrowserExtractHoverResult
} from '../../shared/browser-grab-types'
import type {
  BrowserCookieImportResult,
  BrowserSessionProfile,
  BrowserSessionProfileScope
} from '../../shared/types'

let trustedBrowserRendererWebContentsId: number | null = null

export function setTrustedBrowserRendererWebContentsId(webContentsId: number | null): void {
  trustedBrowserRendererWebContentsId = webContentsId
}

function isTrustedBrowserRenderer(sender: Electron.WebContents): boolean {
  if (sender.isDestroyed() || sender.getType() !== 'window') {
    return false
  }
  if (trustedBrowserRendererWebContentsId != null) {
    return sender.id === trustedBrowserRendererWebContentsId
  }

  const senderUrl = sender.getURL()
  if (process.env.ELECTRON_RENDERER_URL) {
    try {
      return new URL(senderUrl).origin === new URL(process.env.ELECTRON_RENDERER_URL).origin
    } catch {
      return false
    }
  }

  return senderUrl.startsWith('file://')
}

export function registerBrowserHandlers(): void {
  ipcMain.removeHandler('browser:registerGuest')
  ipcMain.removeHandler('browser:unregisterGuest')
  ipcMain.removeHandler('browser:openDevTools')
  ipcMain.removeHandler('browser:acceptDownload')
  ipcMain.removeHandler('browser:cancelDownload')
  ipcMain.removeHandler('browser:setGrabMode')
  ipcMain.removeHandler('browser:awaitGrabSelection')
  ipcMain.removeHandler('browser:cancelGrab')
  ipcMain.removeHandler('browser:captureSelectionScreenshot')
  ipcMain.removeHandler('browser:extractHoverPayload')

  ipcMain.handle(
    'browser:registerGuest',
    (event, args: { browserPageId: string; workspaceId: string; webContentsId: number }) => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return false
      }
      browserManager.registerGuest({
        ...args,
        rendererWebContentsId: event.sender.id
      })
      return true
    }
  )

  ipcMain.handle('browser:unregisterGuest', (event, args: { browserPageId: string }) => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return false
    }
    browserManager.unregisterGuest(args.browserPageId)
    return true
  })

  ipcMain.handle('browser:openDevTools', (event, args: { browserPageId: string }) => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return false
    }
    return browserManager.openDevTools(args.browserPageId)
  })

  ipcMain.handle('browser:acceptDownload', async (event, args: { downloadId: string }) => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return { ok: false, reason: 'not-authorized' as const }
    }
    const prompt = browserManager.getDownloadPrompt(args.downloadId, event.sender.id)
    if (!prompt) {
      return { ok: false, reason: 'not-ready' as const }
    }

    const parent = BrowserWindow.fromWebContents(event.sender)
    const result = parent
      ? await dialog.showSaveDialog(parent, { defaultPath: prompt.filename })
      : await dialog.showSaveDialog({ defaultPath: prompt.filename })
    if (result.canceled || !result.filePath) {
      browserManager.cancelDownload({
        downloadId: args.downloadId,
        senderWebContentsId: event.sender.id
      })
      return { ok: false, reason: 'canceled' as const }
    }

    return browserManager.acceptDownload({
      downloadId: args.downloadId,
      senderWebContentsId: event.sender.id,
      savePath: result.filePath
    })
  })

  ipcMain.handle('browser:cancelDownload', (event, args: { downloadId: string }) => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return false
    }
    return browserManager.cancelDownload({
      downloadId: args.downloadId,
      senderWebContentsId: event.sender.id
    })
  })

  // --- Browser Context Grab IPC ---

  ipcMain.handle(
    'browser:setGrabMode',
    async (event, args: BrowserSetGrabModeArgs): Promise<BrowserSetGrabModeResult> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return { ok: false, reason: 'not-authorized' }
      }
      const guest = browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id)
      if (!guest) {
        return { ok: false, reason: 'not-ready' }
      }
      const success = await browserManager.setGrabMode(args.browserPageId, args.enabled, guest)
      return success ? { ok: true } : { ok: false, reason: 'not-ready' }
    }
  )

  ipcMain.handle(
    'browser:awaitGrabSelection',
    async (event, args: BrowserAwaitGrabSelectionArgs): Promise<BrowserGrabResult> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return { opId: args.opId, kind: 'error', reason: 'Not authorized' }
      }
      const guest = browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id)
      if (!guest) {
        return { opId: args.opId, kind: 'error', reason: 'Guest not ready' }
      }
      // Why: no hasActiveGrabOp guard here — awaitGrabSelection already handles
      // the conflict by cancelling the previous op. Blocking at the IPC layer
      // would create a race window where rearm() fails if the previous IPC call
      // hasn't fully resolved yet.
      return browserManager.awaitGrabSelection(args.browserPageId, args.opId, guest)
    }
  )

  ipcMain.handle('browser:cancelGrab', (event, args: BrowserCancelGrabArgs): boolean => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return false
    }
    // Why: verify the sender actually owns this tab, consistent with the
    // authorization check in setGrabMode/awaitGrabSelection/captureScreenshot.
    const guest = browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id)
    if (!guest) {
      return false
    }
    browserManager.cancelGrabOp(args.browserPageId, 'user')
    return true
  })

  ipcMain.handle(
    'browser:captureSelectionScreenshot',
    async (
      event,
      args: BrowserCaptureSelectionScreenshotArgs
    ): Promise<BrowserCaptureSelectionScreenshotResult> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return { ok: false, reason: 'Not authorized' }
      }
      const guest = browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id)
      if (!guest) {
        return { ok: false, reason: 'Guest not ready' }
      }
      const screenshot = await browserManager.captureSelectionScreenshot(
        args.browserPageId,
        args.rect,
        guest
      )
      if (!screenshot) {
        return { ok: false, reason: 'Screenshot capture failed' }
      }
      return { ok: true, screenshot }
    }
  )

  ipcMain.handle(
    'browser:extractHoverPayload',
    async (event, args: BrowserExtractHoverArgs): Promise<BrowserExtractHoverResult> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return { ok: false, reason: 'Not authorized' }
      }
      const guest = browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id)
      if (!guest) {
        return { ok: false, reason: 'Guest not ready' }
      }
      const payload = await browserManager.extractHoverPayload(args.browserPageId, guest)
      if (!payload) {
        return { ok: false, reason: 'No element hovered' }
      }
      return { ok: true, payload }
    }
  )

  // --- Browser Session Profile IPC ---

  ipcMain.removeHandler('browser:session:listProfiles')
  ipcMain.removeHandler('browser:session:createProfile')
  ipcMain.removeHandler('browser:session:deleteProfile')
  ipcMain.removeHandler('browser:session:importCookies')
  ipcMain.removeHandler('browser:session:resolvePartition')

  ipcMain.handle('browser:session:listProfiles', (event): BrowserSessionProfile[] => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return []
    }
    return browserSessionRegistry.listProfiles()
  })

  ipcMain.handle(
    'browser:session:createProfile',
    (
      event,
      args: { scope: BrowserSessionProfileScope; label: string }
    ): BrowserSessionProfile | null => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return null
      }
      return browserSessionRegistry.createProfile(args.scope, args.label)
    }
  )

  ipcMain.handle(
    'browser:session:deleteProfile',
    async (event, args: { profileId: string }): Promise<boolean> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return false
      }
      return browserSessionRegistry.deleteProfile(args.profileId)
    }
  )

  ipcMain.handle(
    'browser:session:importCookies',
    async (event, args: { profileId: string }): Promise<BrowserCookieImportResult> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return { ok: false, reason: 'Not authorized' }
      }
      const profile = browserSessionRegistry.getProfile(args.profileId)
      if (!profile) {
        return { ok: false, reason: 'Session profile not found.' }
      }

      const parent = BrowserWindow.fromWebContents(event.sender)
      const filePath = await pickCookieFile(parent)
      if (!filePath) {
        return { ok: false, reason: 'canceled' }
      }

      const result = await importCookiesFromFile(filePath, profile.partition)
      if (result.ok) {
        browserSessionRegistry.updateProfileSource(args.profileId, {
          browserFamily: 'manual',
          importedAt: Date.now()
        })
        return { ...result, profileId: args.profileId }
      }
      return result
    }
  )

  ipcMain.handle(
    'browser:session:resolvePartition',
    (event, args: { profileId: string | null }): string | null => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return null
      }
      return browserSessionRegistry.resolvePartition(args.profileId)
    }
  )

  ipcMain.removeHandler('browser:session:clearDefaultCookies')

  ipcMain.handle('browser:session:clearDefaultCookies', async (event): Promise<boolean> => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return false
    }
    return browserSessionRegistry.clearDefaultSessionCookies()
  })

  ipcMain.removeHandler('browser:session:detectBrowsers')
  ipcMain.removeHandler('browser:session:importFromBrowser')

  ipcMain.handle('browser:session:detectBrowsers', (event): DetectedBrowser[] => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return []
    }
    return detectInstalledBrowsers()
  })

  ipcMain.handle(
    'browser:session:importFromBrowser',
    async (
      event,
      args: { profileId: string; browserFamily: string }
    ): Promise<BrowserCookieImportResult> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return { ok: false, reason: 'Not authorized' }
      }
      const profile = browserSessionRegistry.getProfile(args.profileId)
      if (!profile) {
        return { ok: false, reason: 'Session profile not found.' }
      }

      const browsers = detectInstalledBrowsers()
      const browser = browsers.find((b) => b.family === args.browserFamily)
      if (!browser) {
        return { ok: false, reason: 'Browser not found on this system.' }
      }

      const result = await importCookiesFromBrowser(browser, profile.partition)
      if (result.ok) {
        browserSessionRegistry.updateProfileSource(args.profileId, {
          browserFamily: browser.family,
          profileName: 'Default',
          importedAt: Date.now()
        })
        return { ...result, profileId: args.profileId }
      }
      return result
    }
  )
}
