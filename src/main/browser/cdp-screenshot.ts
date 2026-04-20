import type { WebContents } from 'electron'

// Why: Electron's debugger.sendCommand('Page.captureScreenshot') hangs on webview
// guests. Use capturePage() with retry for slow compositing.
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
  const format = (params?.format as string) ?? 'png'
  const attempt = async (retries: number): Promise<void> => {
    try {
      if (webContents.isDestroyed()) {
        onError('WebContents destroyed')
        return
      }
      const image = await webContents.capturePage()
      if (image.isEmpty()) {
        if (retries > 0) {
          setTimeout(() => attempt(retries - 1), 200)
          return
        }
        onError(
          'Screenshot captured an empty image — the browser tab may not be visible in the Orca UI.'
        )
        return
      }
      const data =
        format === 'jpeg' ? image.toJPEG(80).toString('base64') : image.toPNG().toString('base64')
      onResult({ data })
    } catch (err) {
      onError((err as Error).message)
    }
  }
  setTimeout(() => attempt(3), 100)
}
