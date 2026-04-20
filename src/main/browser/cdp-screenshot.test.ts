import { afterEach, describe, expect, it, vi } from 'vitest'

import { captureScreenshot } from './cdp-screenshot'

function createMockWebContents() {
  return {
    isDestroyed: vi.fn(() => false),
    invalidate: vi.fn(),
    capturePage: vi.fn(),
    debugger: {
      isAttached: vi.fn(() => true),
      sendCommand: vi.fn()
    }
  }
}

describe('captureScreenshot', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('invalidates the guest before forwarding Page.captureScreenshot', async () => {
    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockResolvedValueOnce({ data: 'png-data' })
    const onResult = vi.fn()
    const onError = vi.fn()

    captureScreenshot(webContents as never, { format: 'png' }, onResult, onError)
    await Promise.resolve()

    expect(webContents.invalidate).toHaveBeenCalledTimes(1)
    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
      format: 'png'
    })
    expect(onResult).toHaveBeenCalledWith({ data: 'png-data' })
    expect(onError).not.toHaveBeenCalled()
  })

  it('falls back to capturePage when Page.captureScreenshot stalls', async () => {
    vi.useFakeTimers()

    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockImplementation(() => new Promise(() => {}))
    webContents.capturePage.mockResolvedValueOnce({
      isEmpty: () => false,
      toPNG: () => Buffer.from('fallback-png')
    })
    const onResult = vi.fn()
    const onError = vi.fn()

    captureScreenshot(webContents as never, { format: 'png' }, onResult, onError)
    await vi.advanceTimersByTimeAsync(8000)

    expect(webContents.capturePage).toHaveBeenCalledTimes(1)
    expect(onResult).toHaveBeenCalledWith({
      data: Buffer.from('fallback-png').toString('base64')
    })
    expect(onError).not.toHaveBeenCalled()
  })

  it('reports the original timeout when the fallback capture is unavailable', async () => {
    vi.useFakeTimers()

    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockImplementation(() => new Promise(() => {}))
    webContents.capturePage.mockResolvedValueOnce({
      isEmpty: () => true,
      toPNG: () => Buffer.from('unused')
    })
    const onResult = vi.fn()
    const onError = vi.fn()

    captureScreenshot(webContents as never, { format: 'png' }, onResult, onError)
    await vi.advanceTimersByTimeAsync(8000)

    expect(onResult).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(
      'Screenshot timed out — the browser tab may not be visible or the window may not have focus.'
    )
  })
})
