/* eslint-disable max-lines -- Why: the CDP bridge owns debugger lifecycle, ref map management, command serialization, and all browser interaction logic in one module so the browser automation boundary stays coherent. */
import { webContents } from 'electron'
import type {
  BrowserClickResult,
  BrowserEvalResult,
  BrowserFillResult,
  BrowserGotoResult,
  BrowserScreenshotResult,
  BrowserScrollResult,
  BrowserSelectResult,
  BrowserSnapshotResult,
  BrowserTabInfo,
  BrowserTabListResult,
  BrowserTabSwitchResult,
  BrowserTypeResult
} from '../../shared/runtime-types'
import { buildSnapshot, type CdpCommandSender, type SnapshotResult } from './snapshot-engine'
import type { BrowserManager } from './browser-manager'

export class BrowserError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

type TabState = {
  navigationId: string | null
  snapshotResult: SnapshotResult | null
  debuggerAttached: boolean
}

type QueuedCommand = {
  execute: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

export class CdpBridge {
  private activeWebContentsId: number | null = null
  private readonly tabState = new Map<string, TabState>()
  private readonly commandQueues = new Map<string, QueuedCommand[]>()
  private readonly processingQueues = new Set<string>()
  private readonly browserManager: BrowserManager

  constructor(browserManager: BrowserManager) {
    this.browserManager = browserManager
  }

  setActiveTab(webContentsId: number): void {
    this.activeWebContentsId = webContentsId
  }

  getActiveWebContentsId(): number | null {
    return this.activeWebContentsId
  }

  async snapshot(): Promise<BrowserSnapshotResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const result = await buildSnapshot(sender)
      const tabId = this.resolveTabId(guest.id)

      const state = this.getOrCreateTabState(tabId)
      state.snapshotResult = result

      const navId = await this.getNavigationId(sender)
      state.navigationId = navId

      return {
        snapshot: result.snapshot,
        refs: result.refs,
        url: guest.getURL(),
        title: guest.getTitle()
      }
    })
  }

  async click(element: string): Promise<BrowserClickResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const node = await this.resolveRef(guest, sender, element)

      await sender('DOM.scrollIntoViewIfNeeded', { backendNodeId: node.backendDOMNodeId })
      const { model } = (await sender('DOM.getBoxModel', {
        backendNodeId: node.backendDOMNodeId
      })) as { model: { content: number[] } }

      const [x1, y1, , , x3, y3] = model.content
      const cx = (x1 + x3) / 2
      const cy = (y1 + y3) / 2

      await sender('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: cx,
        y: cy,
        button: 'left',
        clickCount: 1
      })
      await sender('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: cx,
        y: cy,
        button: 'left',
        clickCount: 1
      })

      return { clicked: element }
    })
  }

  async goto(url: string): Promise<BrowserGotoResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const { errorText } = (await sender('Page.navigate', { url })) as {
        errorText?: string
      }

      if (errorText) {
        throw new BrowserError('browser_navigation_failed', `Navigation failed: ${errorText}`)
      }

      await this.waitForLoad(sender)
      this.invalidateRefMap(guest.id)

      return { url: guest.getURL(), title: guest.getTitle() }
    })
  }

  async fill(element: string, value: string): Promise<BrowserFillResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const node = await this.resolveRef(guest, sender, element)

      await sender('DOM.focus', { backendNodeId: node.backendDOMNodeId })

      // Why: select-all then delete clears any existing value before typing,
      // matching the behavior of Playwright's fill() and agent-browser's fill.
      await sender('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'a',
        modifiers: process.platform === 'darwin' ? 4 : 2
      })
      await sender('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'a',
        modifiers: process.platform === 'darwin' ? 4 : 2
      })
      await sender('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete' })
      await sender('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete' })

      await sender('Input.insertText', { text: value })

      return { filled: element }
    })
  }

  async type(input: string): Promise<BrowserTypeResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      await sender('Input.insertText', { text: input })
      return { typed: true }
    })
  }

  async select(element: string, value: string): Promise<BrowserSelectResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const node = await this.resolveRef(guest, sender, element)
      const { nodeId } = (await sender('DOM.requestNode', {
        backendNodeId: node.backendDOMNodeId
      })) as { nodeId: number }

      const { object } = (await sender('DOM.resolveNode', { nodeId })) as {
        object: { objectId: string }
      }

      await sender('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: `function(val) {
          this.value = val;
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
        }`,
        arguments: [{ value }]
      })

      return { selected: element }
    })
  }

  async scroll(direction: 'up' | 'down', amount?: number): Promise<BrowserScrollResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const { result: viewportResult } = (await sender('Runtime.evaluate', {
        expression: 'JSON.stringify({ w: window.innerWidth, h: window.innerHeight })',
        returnByValue: true
      })) as { result: { value: string } }
      const viewport = JSON.parse(viewportResult.value) as { w: number; h: number }
      const scrollAmount = amount ?? viewport.h

      const deltaY = direction === 'down' ? scrollAmount : -scrollAmount
      await sender('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: viewport.w / 2,
        y: viewport.h / 2,
        deltaX: 0,
        deltaY
      })

      return { scrolled: direction }
    })
  }

  async back(): Promise<{ url: string; title: string }> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      await sender('Page.navigateToHistoryEntry', {
        entryId: await this.getPreviousHistoryEntryId(sender)
      })
      await this.waitForLoad(sender)
      this.invalidateRefMap(guest.id)

      return { url: guest.getURL(), title: guest.getTitle() }
    })
  }

  async reload(): Promise<{ url: string; title: string }> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      await sender('Page.reload')
      await this.waitForLoad(sender)
      this.invalidateRefMap(guest.id)

      return { url: guest.getURL(), title: guest.getTitle() }
    })
  }

  async screenshot(format: 'png' | 'jpeg' = 'png'): Promise<BrowserScreenshotResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const { data } = (await sender('Page.captureScreenshot', {
        format
      })) as { data: string }

      return { data, format }
    })
  }

  async evaluate(expression: string): Promise<BrowserEvalResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const { result, exceptionDetails } = (await sender('Runtime.evaluate', {
        expression,
        returnByValue: true
      })) as {
        result: { value?: unknown; type: string; description?: string }
        exceptionDetails?: { text: string; exception?: { description?: string } }
      }

      if (exceptionDetails) {
        throw new BrowserError(
          'browser_eval_error',
          exceptionDetails.exception?.description ?? exceptionDetails.text
        )
      }

      return {
        value: result.value !== undefined ? String(result.value) : (result.description ?? '')
      }
    })
  }

  tabList(): BrowserTabListResult {
    const tabs: BrowserTabInfo[] = []
    let index = 0

    for (const [_tabId, wcId] of this.getRegisteredTabs()) {
      const guest = webContents.fromId(wcId)
      if (!guest || guest.isDestroyed()) {
        continue
      }
      tabs.push({
        index,
        url: guest.getURL(),
        title: guest.getTitle(),
        active: wcId === this.activeWebContentsId
      })
      index++
    }

    return { tabs }
  }

  async tabSwitch(index: number): Promise<BrowserTabSwitchResult> {
    const entries = [...this.getRegisteredTabs()]
    if (index < 0 || index >= entries.length) {
      throw new BrowserError(
        'browser_tab_not_found',
        `Tab index ${index} is out of range. ${entries.length} tab(s) open.`
      )
    }

    const [_tabId, wcId] = entries[index]
    if (this.activeWebContentsId !== null) {
      this.invalidateRefMap(this.activeWebContentsId)
    }
    this.activeWebContentsId = wcId

    return { switched: index }
  }

  onTabClosed(webContentsId: number): void {
    if (this.activeWebContentsId === webContentsId) {
      this.activeWebContentsId = null
    }
    const tabId = this.resolveTabIdSafe(webContentsId)
    if (tabId) {
      this.tabState.delete(tabId)
      this.commandQueues.delete(tabId)
    }
  }

  onTabChanged(webContentsId: number): void {
    this.activeWebContentsId = webContentsId
  }

  // ── Private helpers ──

  private getActiveGuest(): Electron.WebContents {
    if (this.activeWebContentsId !== null) {
      const guest = webContents.fromId(this.activeWebContentsId)
      if (guest && !guest.isDestroyed()) {
        return guest
      }
      // Why: the stored webContentsId may be stale after a Chromium process swap
      // (navigation to a different-origin page, crash recovery). Fall through to
      // the auto-select logic rather than immediately failing, since the tab may
      // still be alive under a new webContentsId.
      this.activeWebContentsId = null
    }

    const tabs = [...this.getRegisteredTabs()]
    if (tabs.length === 0) {
      throw new BrowserError(
        'browser_no_tab',
        'No browser tab is open. Use the Orca UI to open a browser tab first.'
      )
    }
    if (tabs.length === 1) {
      this.activeWebContentsId = tabs[0][1]
    } else {
      throw new BrowserError(
        'browser_no_tab',
        "Multiple browser tabs are open. Run 'orca tab list' and 'orca tab switch --index <n>' to select one."
      )
    }

    const guest = webContents.fromId(this.activeWebContentsId!)
    if (!guest || guest.isDestroyed()) {
      this.activeWebContentsId = null
      throw new BrowserError(
        'browser_debugger_detached',
        "The active browser tab was closed. Run 'orca tab list' to find remaining tabs."
      )
    }
    return guest
  }

  private getRegisteredTabs(): Map<string, number> {
    // Why: BrowserManager's tab maps are private. We access the singleton's
    // state via the public getGuestWebContentsId method by iterating known tabs.
    // This method provides the tab enumeration the CDP bridge needs without
    // modifying BrowserManager's encapsulation. In the future a public
    // listTabs() method on BrowserManager would be cleaner.
    return (this.browserManager as unknown as { webContentsIdByTabId: Map<string, number> })
      .webContentsIdByTabId
  }

  private resolveTabId(webContentsId: number): string {
    for (const [tabId, wcId] of this.getRegisteredTabs()) {
      if (wcId === webContentsId) {
        return tabId
      }
    }
    throw new BrowserError('browser_debugger_detached', 'Tab is no longer registered.')
  }

  private resolveTabIdSafe(webContentsId: number): string | null {
    for (const [tabId, wcId] of this.getRegisteredTabs()) {
      if (wcId === webContentsId) {
        return tabId
      }
    }
    return null
  }

  private getOrCreateTabState(tabId: string): TabState {
    let state = this.tabState.get(tabId)
    if (!state) {
      state = { navigationId: null, snapshotResult: null, debuggerAttached: false }
      this.tabState.set(tabId, state)
    }
    return state
  }

  private async ensureDebuggerAttached(guest: Electron.WebContents): Promise<void> {
    const tabId = this.resolveTabId(guest.id)
    const state = this.getOrCreateTabState(tabId)
    if (state.debuggerAttached) {
      return
    }

    try {
      guest.debugger.attach('1.3')
    } catch {
      throw new BrowserError(
        'browser_cdp_error',
        'Could not attach debugger. DevTools may already be open for this tab.'
      )
    }

    await this.makeCdpSender(guest)('Page.enable')
    await this.makeCdpSender(guest)('DOM.enable')

    guest.debugger.on('detach', () => {
      state.debuggerAttached = false
      state.snapshotResult = null
    })

    guest.debugger.on('message', (_event: unknown, method: string) => {
      if (method === 'Page.frameNavigated') {
        state.snapshotResult = null
        state.navigationId = null
      }
    })

    state.debuggerAttached = true
  }

  private makeCdpSender(guest: Electron.WebContents): CdpCommandSender {
    return (method: string, params?: Record<string, unknown>) => {
      const command = guest.debugger.sendCommand(method, params) as Promise<unknown>
      // Why: Electron's CDP sendCommand can hang indefinitely if the debugger
      // session is stale (e.g. after a renderer process swap that wasn't detected).
      // A 10s timeout prevents the RPC from blocking until the CLI's socket timeout.
      return Promise.race([
        command,
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(new BrowserError('browser_cdp_error', `CDP command "${method}" timed out`)),
            10_000
          )
        )
      ])
    }
  }

  private async resolveRef(
    guest: Electron.WebContents,
    sender: CdpCommandSender,
    ref: string
  ): Promise<{ backendDOMNodeId: number; role: string; name: string }> {
    const tabId = this.resolveTabId(guest.id)
    const state = this.getOrCreateTabState(tabId)

    if (!state.snapshotResult) {
      throw new BrowserError(
        'browser_stale_ref',
        "No snapshot exists for this tab. Run 'orca snapshot' first."
      )
    }

    const entry = state.snapshotResult.refMap.get(ref)
    if (!entry) {
      throw new BrowserError(
        'browser_ref_not_found',
        `Element ref ${ref} was not found. Run 'orca snapshot' to see available refs.`
      )
    }

    const currentNavId = await this.getNavigationId(sender)
    if (state.navigationId && currentNavId !== state.navigationId) {
      state.snapshotResult = null
      state.navigationId = null
      throw new BrowserError(
        'browser_stale_ref',
        "The page has navigated since the last snapshot. Run 'orca snapshot' to get fresh refs."
      )
    }

    try {
      await sender('DOM.describeNode', { backendNodeId: entry.backendDOMNodeId })
    } catch {
      state.snapshotResult = null
      throw new BrowserError(
        'browser_stale_ref',
        `Element ${ref} no longer exists in the DOM. Run 'orca snapshot' to get fresh refs.`
      )
    }

    return entry
  }

  private async getNavigationId(sender: CdpCommandSender): Promise<string> {
    const { entries, currentIndex } = (await sender('Page.getNavigationHistory')) as {
      entries: { id: number; url: string }[]
      currentIndex: number
    }
    const current = entries[currentIndex]
    return current ? `${current.id}:${current.url}` : 'unknown'
  }

  private async getPreviousHistoryEntryId(sender: CdpCommandSender): Promise<number> {
    const { entries, currentIndex } = (await sender('Page.getNavigationHistory')) as {
      entries: { id: number }[]
      currentIndex: number
    }
    if (currentIndex <= 0) {
      throw new BrowserError('browser_navigation_failed', 'No previous history entry.')
    }
    return entries[currentIndex - 1].id
  }

  private async waitForLoad(sender: CdpCommandSender): Promise<void> {
    await sender('Page.enable')
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new BrowserError('browser_timeout', 'Page load timed out after 30 seconds.'))
      }, 30_000)

      const check = async (): Promise<void> => {
        try {
          const { result } = (await sender('Runtime.evaluate', {
            expression: 'document.readyState',
            returnByValue: true
          })) as { result: { value: string } }
          if (result.value === 'complete') {
            clearTimeout(timeout)
            resolve()
          } else {
            setTimeout(check, 100)
          }
        } catch {
          clearTimeout(timeout)
          reject(new BrowserError('browser_cdp_error', 'Failed to check page load state.'))
        }
      }
      check()
    })
  }

  private invalidateRefMap(webContentsId: number): void {
    const tabId = this.resolveTabIdSafe(webContentsId)
    if (tabId) {
      const state = this.tabState.get(tabId)
      if (state) {
        state.snapshotResult = null
        state.navigationId = null
      }
    }
  }

  private async enqueueCommand<T>(execute: () => Promise<T>): Promise<T> {
    const guest = this.getActiveGuest()
    const tabId = this.resolveTabId(guest.id)

    return new Promise<T>((resolve, reject) => {
      let queue = this.commandQueues.get(tabId)
      if (!queue) {
        queue = []
        this.commandQueues.set(tabId, queue)
      }
      queue.push({
        execute: execute as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject
      })
      this.processQueue(tabId)
    })
  }

  private async processQueue(tabId: string): Promise<void> {
    if (this.processingQueues.has(tabId)) {
      return
    }
    this.processingQueues.add(tabId)

    const queue = this.commandQueues.get(tabId)
    while (queue && queue.length > 0) {
      const cmd = queue.shift()!
      try {
        const result = await cmd.execute()
        cmd.resolve(result)
      } catch (error) {
        cmd.reject(error)
      }
    }

    this.processingQueues.delete(tabId)
  }
}
