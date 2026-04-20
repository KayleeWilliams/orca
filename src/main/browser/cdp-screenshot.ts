import type { WebContents } from 'electron'

// Why: Electron's capturePage() is unreliable on webview guests — the compositor
// may not produce frames when the webview panel is inactive, unfocused, or in a
// split-pane layout. Instead, use the debugger's Page.captureScreenshot which
// renders server-side in the Blink compositor and doesn't depend on OS-level
// window focus or display state. Guard with a timeout so agent-browser doesn't
// hang on its 30s CDP timeout if the debugger stalls.
export function captureScreenshot(
  webContents: WebContents,
  params: Record<string, unknown> | undefined,
  onResult: (result: unknown) => void,
  onError: (message: string) => void
): void {
  if (webContents.isDestroyed()) {
    onError('WebContents destroyed')
    return
  }
  const dbg = webContents.debugger
  if (!dbg.isAttached()) {
    onError('Debugger not attached')
    return
  }

  const screenshotParams: Record<string, unknown> = {}
  if (params?.format) {
    screenshotParams.format = params.format
  }
  if (params?.quality) {
    screenshotParams.quality = params.quality
  }
  if (params?.clip) {
    screenshotParams.clip = params.clip
  }
  if (params?.captureBeyondViewport != null) {
    screenshotParams.captureBeyondViewport = params.captureBeyondViewport
  }
  if (params?.fromSurface != null) {
    screenshotParams.fromSurface = params.fromSurface
  }

  let settled = false
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true
      onError(
        'Screenshot timed out — the browser tab may not be visible or the window may not have focus.'
      )
    }
  }, 8000)

  dbg
    .sendCommand('Page.captureScreenshot', screenshotParams)
    .then((result) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        onResult(result)
      }
    })
    .catch((err) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        onError((err as Error).message)
      }
    })
}
