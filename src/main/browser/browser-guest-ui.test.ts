import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { screenGetCursorScreenPointMock } = vi.hoisted(() => ({
  screenGetCursorScreenPointMock: vi.fn(() => ({ x: 0, y: 0 }))
}))

vi.mock('electron', () => ({
  screen: { getCursorScreenPoint: screenGetCursorScreenPointMock },
  webContents: { fromId: vi.fn() }
}))

import { setupGuestContextMenu, setupGuestShortcutForwarding } from './browser-guest-ui'

describe('setupGuestContextMenu', () => {
  const browserTabId = 'tab-1'
  let rendererSendMock: ReturnType<typeof vi.fn>
  let guestOnMock: ReturnType<typeof vi.fn>
  let guestOffMock: ReturnType<typeof vi.fn>

  function makeGuest(overrides: Record<string, unknown> = {}) {
    return {
      getURL: vi.fn(() => 'https://example.com'),
      canGoBack: vi.fn(() => true),
      canGoForward: vi.fn(() => false),
      on: guestOnMock,
      off: guestOffMock,
      ...overrides
    } as unknown as Electron.WebContents
  }

  function makeRenderer() {
    return { send: rendererSendMock } as unknown as Electron.WebContents
  }

  beforeEach(() => {
    rendererSendMock = vi.fn()
    guestOnMock = vi.fn()
    guestOffMock = vi.fn()
    screenGetCursorScreenPointMock.mockReturnValue({ x: 0, y: 0 })
  })

  function triggerContextMenu(
    _guest: Electron.WebContents,
    params: Partial<Electron.ContextMenuParams>
  ) {
    const handler = guestOnMock.mock.calls.find((call) => call[0] === 'context-menu')?.[1] as
      | ((event: unknown, params: Electron.ContextMenuParams) => void)
      | undefined

    expect(handler).toBeTypeOf('function')
    handler!({}, { x: 0, y: 0, linkURL: '', ...params } as Electron.ContextMenuParams)
  }

  it('passes through guest viewport coordinates (params.x/y) to the renderer', () => {
    const guest = makeGuest()
    const renderer = makeRenderer()

    setupGuestContextMenu({
      browserTabId,
      guest,
      resolveRenderer: () => renderer
    })

    triggerContextMenu(guest, { x: 150, y: 275 })

    expect(rendererSendMock).toHaveBeenCalledWith(
      'browser:context-menu-requested',
      expect.objectContaining({ x: 150, y: 275 })
    )
  })

  it('includes navigation state and page URL alongside coordinates', () => {
    screenGetCursorScreenPointMock.mockReturnValue({ x: 500, y: 375 })
    const guest = makeGuest({
      getURL: vi.fn(() => 'https://test.dev/page'),
      canGoBack: vi.fn(() => true),
      canGoForward: vi.fn(() => true)
    })
    const renderer = makeRenderer()

    setupGuestContextMenu({
      browserTabId,
      guest,
      resolveRenderer: () => renderer
    })

    triggerContextMenu(guest, { x: 50, y: 75, linkURL: 'https://test.dev/link' })

    expect(rendererSendMock).toHaveBeenCalledWith('browser:context-menu-requested', {
      browserPageId: browserTabId,
      x: 50,
      y: 75,
      screenX: 500,
      screenY: 375,
      pageUrl: 'https://test.dev/page',
      linkUrl: 'https://test.dev/link',
      canGoBack: true,
      canGoForward: true
    })
  })

  it('does not send when renderer is unavailable', () => {
    const guest = makeGuest()

    setupGuestContextMenu({
      browserTabId,
      guest,
      resolveRenderer: () => null
    })

    triggerContextMenu(guest, { x: 100, y: 200 })

    expect(rendererSendMock).not.toHaveBeenCalled()
  })

  it('cleans up context-menu listener on teardown', () => {
    const guest = makeGuest()

    const cleanup = setupGuestContextMenu({
      browserTabId,
      guest,
      resolveRenderer: () => makeRenderer()
    })

    cleanup()

    expect(guestOffMock).toHaveBeenCalledWith('context-menu', expect.any(Function))
  })

  describe('dismiss handler', () => {
    function triggerMouseEvent(button: string, type: string = 'mouseDown') {
      const beforeMouseHandler = guestOnMock.mock.calls.find(
        (call) => call[0] === 'before-mouse-event'
      )?.[1] as ((event: unknown, mouse: { type: string; button: string }) => void) | undefined

      expect(beforeMouseHandler).toBeTypeOf('function')
      beforeMouseHandler!({}, { type, button })
    }

    it('dismisses context menu on left-click', () => {
      const guest = makeGuest()
      const renderer = makeRenderer()

      setupGuestContextMenu({
        browserTabId,
        guest,
        resolveRenderer: () => renderer
      })

      triggerContextMenu(guest, { x: 100, y: 200 })
      rendererSendMock.mockClear()

      triggerMouseEvent('left')

      expect(rendererSendMock).toHaveBeenCalledWith('browser:context-menu-dismissed', {
        browserPageId: browserTabId
      })
    })

    it('does not dismiss context menu on right-click', () => {
      const guest = makeGuest()
      const renderer = makeRenderer()

      setupGuestContextMenu({
        browserTabId,
        guest,
        resolveRenderer: () => renderer
      })

      triggerContextMenu(guest, { x: 100, y: 200 })
      rendererSendMock.mockClear()

      triggerMouseEvent('right')

      expect(rendererSendMock).not.toHaveBeenCalledWith(
        'browser:context-menu-dismissed',
        expect.anything()
      )
    })

    it('dismisses context menu on middle-click', () => {
      const guest = makeGuest()
      const renderer = makeRenderer()

      setupGuestContextMenu({
        browserTabId,
        guest,
        resolveRenderer: () => renderer
      })

      triggerContextMenu(guest, { x: 100, y: 200 })
      rendererSendMock.mockClear()

      triggerMouseEvent('middle')

      expect(rendererSendMock).toHaveBeenCalledWith('browser:context-menu-dismissed', {
        browserPageId: browserTabId
      })
    })

    it('ignores non-mouseDown events', () => {
      const guest = makeGuest()
      const renderer = makeRenderer()

      setupGuestContextMenu({
        browserTabId,
        guest,
        resolveRenderer: () => renderer
      })

      triggerContextMenu(guest, { x: 100, y: 200 })
      rendererSendMock.mockClear()

      triggerMouseEvent('left', 'mouseMove')

      expect(rendererSendMock).not.toHaveBeenCalled()
    })
  })
})

describe('setupGuestShortcutForwarding', () => {
  const browserTabId = 'tab-1'
  let rendererSendMock: ReturnType<typeof vi.fn>
  let guestOnMock: ReturnType<typeof vi.fn>
  let guestOffMock: ReturnType<typeof vi.fn>
  const originalPlatform = process.platform

  function makeGuest() {
    return {
      on: guestOnMock,
      off: guestOffMock
    } as unknown as Electron.WebContents
  }

  function makeRenderer() {
    return { send: rendererSendMock } as unknown as Electron.WebContents
  }

  beforeEach(() => {
    rendererSendMock = vi.fn()
    guestOnMock = vi.fn()
    guestOffMock = vi.fn()
    // Why: resolveWindowShortcutAction branches on platform; pin darwin so the
    // Cmd+J chord below resolves to toggleWorktreePalette deterministically.
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })

  function triggerBeforeInput(input: Partial<Electron.Input>): void {
    const handler = guestOnMock.mock.calls.find((call) => call[0] === 'before-input-event')?.[1] as
      | ((event: { preventDefault: () => void }, input: Electron.Input) => void)
      | undefined

    expect(handler).toBeTypeOf('function')
    handler!({ preventDefault: vi.fn() }, {
      type: 'keyDown',
      key: 'j',
      code: 'KeyJ',
      meta: false,
      control: false,
      alt: false,
      shift: false,
      ...input
    } as Electron.Input)
  }

  it('emits ui:shortcutConsumed before the forwarded action IPC for Cmd+J', () => {
    const guest = makeGuest()
    const renderer = makeRenderer()

    setupGuestShortcutForwarding({
      browserTabId,
      guest,
      resolveRenderer: () => renderer
    })

    triggerBeforeInput({ key: 'j', code: 'KeyJ', meta: true })

    const channels = rendererSendMock.mock.calls.map((call) => call[0])
    expect(channels).toContain('ui:shortcutConsumed')
    expect(channels).toContain('ui:toggleWorktreePalette')
    // Why: the consumed-shortcut signal must precede the action so the
    // renderer's useModifierHint overlay clears before the action handler runs.
    expect(channels.indexOf('ui:shortcutConsumed')).toBeLessThan(
      channels.indexOf('ui:toggleWorktreePalette')
    )
  })

  it('emits ui:shortcutConsumed before ui:worktreeHistoryNavigate on Cmd+Alt+Left', () => {
    const guest = makeGuest()
    const renderer = makeRenderer()

    setupGuestShortcutForwarding({
      browserTabId,
      guest,
      resolveRenderer: () => renderer
    })

    // Why: Cmd+Alt+Left is the Alt-exempt worktreeHistoryNavigate chord,
    // structurally different from the modifier-chord ladder covered above.
    triggerBeforeInput({ key: 'ArrowLeft', code: 'ArrowLeft', meta: true, alt: true })

    const channels = rendererSendMock.mock.calls.map((call) => call[0])
    expect(channels).toContain('ui:shortcutConsumed')
    expect(channels).toContain('ui:worktreeHistoryNavigate')
    expect(channels.indexOf('ui:shortcutConsumed')).toBeLessThan(
      channels.indexOf('ui:worktreeHistoryNavigate')
    )
  })

  it('preventDefaults Cmd+Alt+Left without emitting when renderer is unavailable', () => {
    const guest = makeGuest()
    const preventDefaultMock = vi.fn()

    setupGuestShortcutForwarding({
      browserTabId,
      guest,
      resolveRenderer: () => null
    })

    const handler = guestOnMock.mock.calls.find((call) => call[0] === 'before-input-event')?.[1] as
      | ((event: { preventDefault: () => void }, input: Electron.Input) => void)
      | undefined
    expect(handler).toBeTypeOf('function')

    handler!({ preventDefault: preventDefaultMock }, {
      type: 'keyDown',
      key: 'ArrowLeft',
      code: 'ArrowLeft',
      meta: true,
      control: false,
      alt: true,
      shift: false
    } as Electron.Input)

    // Why: preventDefault fires unconditionally so Chromium/guest doesn't
    // handle the chord as its own navigation. No IPC sends because renderer
    // is null — emitConsumedShortcut no-ops on undefined.
    expect(preventDefaultMock).toHaveBeenCalledTimes(1)
    expect(rendererSendMock).not.toHaveBeenCalled()
  })
})
