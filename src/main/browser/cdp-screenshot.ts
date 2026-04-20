import type { WebContents } from 'electron'

function encodeNativeImageScreenshot(
  image: Electron.NativeImage,
  params: Record<string, unknown> | undefined
): { data: string } | null {
  if (image.isEmpty()) {
    return null
  }

  const format = params?.format === 'jpeg' ? 'jpeg' : 'png'
  const quality =
    typeof params?.quality === 'number' && Number.isFinite(params.quality)
      ? Math.max(0, Math.min(100, Math.round(params.quality)))
      : undefined
  const buffer = format === 'jpeg' ? image.toJPEG(quality ?? 90) : image.toPNG()
  return { data: buffer.toString('base64') }
}

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
  // Why: a compositor invalidate is cheap and can recover guest instances that
  // are visible but have not produced a fresh frame since being reclaimed into
  // the active browser tab.
  try {
    webContents.invalidate()
  } catch {
    // Some guest teardown paths reject repaint requests. Fall through to CDP.
  }
  const timer = setTimeout(async () => {
    if (!settled) {
      try {
        const fallback = encodeNativeImageScreenshot(await webContents.capturePage(), params)
        if (fallback) {
          settled = true
          onResult(fallback)
          return
        }
      } catch {
        // Fall through to the original timeout error below.
      }

      if (!settled) {
        settled = true
        onError(
          'Screenshot timed out — the browser tab may not be visible or the window may not have focus.'
        )
      }
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
