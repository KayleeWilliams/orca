import { clearLiveBrowserUrl } from './browser-runtime'

export const webviewRegistry = new Map<string, Electron.WebviewTag>()
export const registeredWebContentsIds = new Map<string, number>()
export const parkedAtByTabId = new Map<string, number>()

export function destroyPersistentWebview(browserTabId: string): void {
  const webview = webviewRegistry.get(browserTabId)
  if (!webview) {
    registeredWebContentsIds.delete(browserTabId)
    parkedAtByTabId.delete(browserTabId)
    clearLiveBrowserUrl(browserTabId)
    return
  }
  // Why: webview.remove() does not synchronously destroy the guest web
  // contents — Chromium keeps the media session alive until GC, so media
  // keys (F8 play/pause) can still control a "dead" tab. Loading
  // about:blank tears down the page's media session immediately and
  // synchronously before the element is removed from the DOM.
  try {
    webview.stop()
    webview.loadURL('about:blank')
  } catch {
    // Webview may already be in a torn-down state — safe to ignore.
  }
  void window.api.browser.unregisterGuest({ browserPageId: browserTabId })
  webview.remove()
  webviewRegistry.delete(browserTabId)
  registeredWebContentsIds.delete(browserTabId)
  parkedAtByTabId.delete(browserTabId)
  clearLiveBrowserUrl(browserTabId)
}
