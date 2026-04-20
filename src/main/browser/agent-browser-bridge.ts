/* eslint-disable max-lines */
import { execFile } from 'child_process'
import { existsSync, accessSync, chmodSync, readFileSync, constants } from 'fs'
import { join } from 'path'
import { platform, arch } from 'os'
import { app } from 'electron'
import { CdpWsProxy } from './cdp-ws-proxy'
import type { BrowserManager } from './browser-manager'
import { BrowserError } from './cdp-bridge'
import type {
  BrowserTabInfo,
  BrowserTabListResult,
  BrowserTabSwitchResult,
  BrowserSnapshotResult,
  BrowserClickResult,
  BrowserGotoResult,
  BrowserFillResult,
  BrowserTypeResult,
  BrowserSelectResult,
  BrowserScrollResult,
  BrowserBackResult,
  BrowserReloadResult,
  BrowserScreenshotResult,
  BrowserEvalResult,
  BrowserHoverResult,
  BrowserDragResult,
  BrowserUploadResult,
  BrowserWaitResult,
  BrowserCheckResult,
  BrowserFocusResult,
  BrowserClearResult,
  BrowserSelectAllResult,
  BrowserKeypressResult,
  BrowserPdfResult,
  BrowserCookieGetResult,
  BrowserCookieSetResult,
  BrowserCookieDeleteResult,
  BrowserViewportResult,
  BrowserGeolocationResult,
  BrowserInterceptEnableResult,
  BrowserInterceptDisableResult,
  BrowserInterceptContinueResult,
  BrowserInterceptBlockResult,
  BrowserConsoleResult,
  BrowserNetworkLogResult,
  BrowserCaptureStartResult,
  BrowserCaptureStopResult,
  BrowserCookie
} from '../../shared/runtime-types'

// Why: must exceed agent-browser's internal per-command timeouts (goto defaults to 30s,
// wait can be up to 60s). Using 90s ensures the bridge never kills a command before
// agent-browser's own timeout fires and returns a proper error.
const EXEC_TIMEOUT_MS = 90_000
const CONSECUTIVE_TIMEOUT_LIMIT = 3

type SessionState = {
  proxy: CdpWsProxy
  cdpEndpoint: string
  initialized: boolean
  consecutiveTimeouts: number
  // Why: track active interception patterns so they can be re-enabled after session restart
  activeInterceptPatterns: string[]
  activeCapture: boolean
  // Why: store the webContentsId so we can verify the tab is still alive at execution time,
  // not just at enqueue time. The queue delay can allow the tab to be destroyed in between.
  webContentsId: number
}

type QueuedCommand = {
  execute: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

function agentBrowserNativeName(): string {
  const ext = process.platform === 'win32' ? '.exe' : ''
  return `agent-browser-${platform()}-${arch()}${ext}`
}

function resolveAgentBrowserBinary(): string {
  // Why: production builds copy the platform-specific binary into resources/
  // via electron-builder extraResources. Check there first.
  const bundled = join(app.getPath('exe'), '..', 'resources', agentBrowserNativeName())
  if (existsSync(bundled)) {
    return bundled
  }

  // Why: in dev mode, resolve directly to the native binary inside node_modules.
  // Use app.getAppPath() for a stable project root — __dirname is unreliable after
  // electron-vite bundles main process code into out/main/index.js.
  const nmBin = join(
    app.getAppPath(),
    'node_modules',
    'agent-browser',
    'bin',
    agentBrowserNativeName()
  )
  if (existsSync(nmBin)) {
    if (process.platform !== 'win32') {
      try {
        accessSync(nmBin, constants.X_OK)
      } catch {
        chmodSync(nmBin, 0o755)
      }
    }
    return nmBin
  }

  // Last resort: assume it's on PATH
  return 'agent-browser'
}

// Why: exec commands arrive as a single string (e.g. 'keyboard inserttext "hello world"').
// Naive split on whitespace breaks quoted arguments. This parser respects double and
// single quotes so the value arrives as a single argument without surrounding quotes.
function parseShellArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let inDouble = false
  let inSingle = false

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
    } else if (ch === "'" && !inDouble) {
      inSingle = !inSingle
    } else if (ch === ' ' && !inDouble && !inSingle) {
      if (current) {
        args.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }
  if (current) {
    args.push(current)
  }
  return args
}

// Why: agent-browser returns generic error messages for stale/unknown refs.
// Map them to a specific code so agents can reliably detect and re-snapshot.
function classifyErrorCode(message: string): string {
  if (/unknown ref|ref not found|element not found: @e/i.test(message)) {
    return 'browser_stale_ref'
  }
  return 'browser_error'
}

function translateResult(
  stdout: string
): { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } } {
  let parsed: { success?: boolean; data?: unknown; error?: string }
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return {
      ok: false,
      error: {
        code: 'browser_error',
        message: `Unexpected output from agent-browser: ${stdout.slice(0, 1000)}`
      }
    }
  }
  if (parsed.success) {
    return { ok: true, result: parsed.data }
  }
  const message = parsed.error ?? 'Unknown browser error'
  return {
    ok: false,
    error: {
      code: classifyErrorCode(message),
      message
    }
  }
}

export class AgentBrowserBridge {
  // Why: per-worktree active tab prevents one worktree's tab switch from
  // affecting another worktree's command targeting.
  private readonly activeWebContentsPerWorktree = new Map<string, number>()
  private activeWebContentsId: number | null = null
  private readonly sessions = new Map<string, SessionState>()
  private readonly commandQueues = new Map<string, QueuedCommand[]>()
  private readonly processingQueues = new Set<string>()
  private readonly agentBrowserBin: string
  // Why: when a process swap destroys a session that had active intercept patterns,
  // store them here keyed by sessionName so the next ensureSession + first successful
  // command can restore them automatically.
  private readonly pendingInterceptRestore = new Map<string, string[]>()
  // Why: two concurrent CLI calls can both enter ensureSession before either creates
  // the session entry. This promise-based lock ensures only one creation proceeds.
  private readonly pendingSessionCreation = new Map<string, Promise<void>>()

  constructor(private readonly browserManager: BrowserManager) {
    this.agentBrowserBin = resolveAgentBrowserBinary()
  }

  // ── Tab tracking ──

  setActiveTab(webContentsId: number, worktreeId?: string): void {
    this.activeWebContentsId = webContentsId
    if (worktreeId) {
      this.activeWebContentsPerWorktree.set(worktreeId, webContentsId)
    }
  }

  getActiveWebContentsId(): number | null {
    return this.activeWebContentsId
  }

  onTabChanged(webContentsId: number, worktreeId?: string): void {
    this.activeWebContentsId = webContentsId
    if (worktreeId) {
      this.activeWebContentsPerWorktree.set(worktreeId, webContentsId)
    }
  }

  async onTabClosed(webContentsId: number): Promise<void> {
    if (this.activeWebContentsId === webContentsId) {
      this.activeWebContentsId = null
    }
    const browserPageId = this.resolveTabIdSafe(webContentsId)
    if (browserPageId) {
      await this.destroySession(`orca-tab-${browserPageId}`)
    }
  }

  async onProcessSwap(browserPageId: string, newWebContentsId: number): Promise<void> {
    // Why: Electron process swaps give same browserPageId but new webContentsId.
    // Old proxy's webContents is destroyed, so destroy session and let next command recreate.
    const sessionName = `orca-tab-${browserPageId}`
    const session = this.sessions.get(sessionName)
    // Why: save active intercept patterns before destroying so they can be restored
    // on the new session after the next successful init command.
    if (session && session.activeInterceptPatterns.length > 0) {
      this.pendingInterceptRestore.set(sessionName, [...session.activeInterceptPatterns])
    }
    await this.destroySession(sessionName)
    this.activeWebContentsId = newWebContentsId
  }

  // ── Worktree-scoped tab queries ──

  getRegisteredTabs(worktreeId?: string): Map<string, number> {
    const all = this.browserManager.getWebContentsIdByTabId()
    if (!worktreeId) {
      return all
    }

    const filtered = new Map<string, number>()
    for (const [tabId, wcId] of all) {
      if (this.browserManager.getWorktreeIdForTab(tabId) === worktreeId) {
        filtered.set(tabId, wcId)
      }
    }
    return filtered
  }

  // ── Tab management ──

  tabList(worktreeId?: string): BrowserTabListResult {
    const tabs = this.getRegisteredTabs(worktreeId)
    // Why: use per-worktree active tab for the "active" flag so tab-list is
    // consistent with what resolveActiveTab would pick for command routing.
    let activeWcId =
      (worktreeId && this.activeWebContentsPerWorktree.get(worktreeId)) ?? this.activeWebContentsId
    const result: BrowserTabInfo[] = []
    let index = 0
    let firstLiveWcId: number | null = null
    for (const [, wcId] of tabs) {
      const wc = this.getWebContents(wcId)
      if (!wc) {
        continue
      }
      if (firstLiveWcId === null) {
        firstLiveWcId = wcId
      }
      result.push({
        index: index++,
        url: wc.getURL() ?? '',
        title: wc.getTitle() ?? '',
        active: wcId === activeWcId
      })
    }
    // Why: if no tab has been explicitly activated (e.g. first use after app
    // start), auto-activate the first live tab so the active flag is never
    // all-false when tabs exist.
    if (activeWcId == null && firstLiveWcId !== null) {
      this.activeWebContentsId = firstLiveWcId
      if (worktreeId) {
        this.activeWebContentsPerWorktree.set(worktreeId, firstLiveWcId)
      }
      if (result.length > 0) {
        result[0].active = true
      }
    }
    return { tabs: result }
  }

  // Why: tab switch must go through the command queue to prevent race conditions
  // with in-flight commands that target the previously active tab.
  async tabSwitch(index: number, worktreeId?: string): Promise<BrowserTabSwitchResult> {
    const tabs = this.getRegisteredTabs(worktreeId)
    const entries = [...tabs.entries()]
    if (index < 0 || index >= entries.length) {
      throw new BrowserError(
        'browser_tab_not_found',
        `Tab index ${index} out of range (0-${entries.length - 1})`
      )
    }
    const [, wcId] = entries[index]
    this.activeWebContentsId = wcId
    // Why: resolveActiveTab prefers the per-worktree map over the global when
    // worktreeId is provided. Without this update, subsequent commands would
    // still route to the previous tab despite tabSwitch reporting success.
    if (worktreeId) {
      this.activeWebContentsPerWorktree.set(worktreeId, wcId)
    }
    return { switched: index }
  }

  // ── Core commands (typed) ──

  async snapshot(worktreeId?: string): Promise<BrowserSnapshotResult> {
    // Why: snapshot creates fresh refs so it must bypass the stale-ref guard
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['snapshot'])) as BrowserSnapshotResult
    })
  }

  async click(element: string, worktreeId?: string): Promise<BrowserClickResult> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['click', element])) as BrowserClickResult
    })
  }

  async dblclick(element: string, worktreeId?: string): Promise<BrowserClickResult> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['dblclick', element])) as BrowserClickResult
    })
  }

  async goto(url: string, worktreeId?: string): Promise<BrowserGotoResult> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['goto', url])) as BrowserGotoResult
    })
  }

  async fill(element: string, value: string, worktreeId?: string): Promise<BrowserFillResult> {
    // Why: Input.insertText via Electron's debugger API does not deliver text to
    // focused inputs in webviews — this is a fundamental Electron limitation.
    // Agent-browser's fill and click also fail for the same reason.
    // Workaround: use agent-browser's focus to resolve the ref, then set the value
    // directly via JS and dispatch input/change events for React/framework compat.
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      await this.execAgentBrowser(sessionName, ['focus', element])
      const escaped = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
      await this.execAgentBrowser(sessionName, [
        'eval',
        `(() => { const el = document.activeElement; if (el) { const nativeSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set; if (nativeSetter) { nativeSetter.call(el, '${escaped}'); } else { el.value = '${escaped}'; } el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } })()`
      ])
      return { filled: element } as BrowserFillResult
    })
  }

  async type(input: string, worktreeId?: string): Promise<BrowserTypeResult> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, [
        'keyboard',
        'type',
        input
      ])) as BrowserTypeResult
    })
  }

  async select(element: string, value: string, worktreeId?: string): Promise<BrowserSelectResult> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, [
        'select',
        element,
        value
      ])) as BrowserSelectResult
    })
  }

  async scroll(
    direction: string,
    amount?: number,
    worktreeId?: string
  ): Promise<BrowserScrollResult> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      const args = ['scroll', direction]
      if (amount != null) {
        args.push(String(amount))
      }
      return (await this.execAgentBrowser(sessionName, args)) as BrowserScrollResult
    })
  }

  async scrollIntoView(element: string, worktreeId?: string): Promise<unknown> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['scrollintoview', element])
    })
  }

  async get(what: string, selector?: string, worktreeId?: string): Promise<unknown> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      const args = ['get', what]
      if (selector) {
        args.push(selector)
      }
      return await this.execAgentBrowser(sessionName, args)
    })
  }

  async is(what: string, selector: string, worktreeId?: string): Promise<unknown> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['is', what, selector])
    })
  }

  // ── Keyboard commands ──

  async keyboardInsertText(text: string, worktreeId?: string): Promise<unknown> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['keyboard', 'inserttext', text])
    })
  }

  // ── Mouse commands ──

  async mouseMove(x: number, y: number, worktreeId?: string): Promise<unknown> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['mouse', 'move', String(x), String(y)])
    })
  }

  async mouseDown(button?: string, worktreeId?: string): Promise<unknown> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      const args = ['mouse', 'down']
      if (button) {
        args.push(button)
      }
      return await this.execAgentBrowser(sessionName, args)
    })
  }

  async mouseUp(button?: string, worktreeId?: string): Promise<unknown> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      const args = ['mouse', 'up']
      if (button) {
        args.push(button)
      }
      return await this.execAgentBrowser(sessionName, args)
    })
  }

  async mouseWheel(dy: number, dx?: number, worktreeId?: string): Promise<unknown> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      const args = ['mouse', 'wheel', String(dy)]
      if (dx != null) {
        args.push(String(dx))
      }
      return await this.execAgentBrowser(sessionName, args)
    })
  }

  // ── Find (semantic locators) ──

  async find(
    locator: string,
    value: string,
    action: string,
    text?: string,
    worktreeId?: string
  ): Promise<unknown> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      const args = ['find', locator, value, action]
      if (text) {
        args.push(text)
      }
      return await this.execAgentBrowser(sessionName, args)
    })
  }

  // ── Set commands ──

  async setDevice(name: string, worktreeId?: string): Promise<unknown> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['set', 'device', name])
    })
  }

  async setOffline(state?: string, worktreeId?: string): Promise<unknown> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      const args = ['set', 'offline']
      if (state) {
        args.push(state)
      }
      return await this.execAgentBrowser(sessionName, args)
    })
  }

  async setHeaders(headersJson: string, worktreeId?: string): Promise<unknown> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['set', 'headers', headersJson])
    })
  }

  async setCredentials(user: string, pass: string, worktreeId?: string): Promise<unknown> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['set', 'credentials', user, pass])
    })
  }

  async setMedia(
    colorScheme?: string,
    reducedMotion?: string,
    worktreeId?: string
  ): Promise<unknown> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      const args = ['set', 'media']
      if (colorScheme) {
        args.push(colorScheme)
      }
      if (reducedMotion) {
        args.push(reducedMotion)
      }
      return await this.execAgentBrowser(sessionName, args)
    })
  }

  // ── Clipboard commands ──

  async clipboardRead(worktreeId?: string): Promise<unknown> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['clipboard', 'read'])
    })
  }

  async clipboardWrite(text: string, worktreeId?: string): Promise<unknown> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['clipboard', 'write', text])
    })
  }

  // ── Dialog commands ──

  async dialogAccept(text?: string, worktreeId?: string): Promise<unknown> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      const args = ['dialog', 'accept']
      if (text) {
        args.push(text)
      }
      return await this.execAgentBrowser(sessionName, args)
    })
  }

  async dialogDismiss(worktreeId?: string): Promise<unknown> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['dialog', 'dismiss'])
    })
  }

  // ── Storage commands ──

  async storageLocalGet(key: string, worktreeId?: string): Promise<unknown> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['storage', 'local', 'get', key])
    })
  }

  async storageLocalSet(key: string, value: string, worktreeId?: string): Promise<unknown> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['storage', 'local', 'set', key, value])
    })
  }

  async storageLocalClear(worktreeId?: string): Promise<unknown> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['storage', 'local', 'clear'])
    })
  }

  async storageSessionGet(key: string, worktreeId?: string): Promise<unknown> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['storage', 'session', 'get', key])
    })
  }

  async storageSessionSet(key: string, value: string, worktreeId?: string): Promise<unknown> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['storage', 'session', 'set', key, value])
    })
  }

  async storageSessionClear(worktreeId?: string): Promise<unknown> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['storage', 'session', 'clear'])
    })
  }

  // ── Download command ──

  async download(selector: string, path: string, worktreeId?: string): Promise<unknown> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['download', selector, path])
    })
  }

  // ── Highlight command ──

  async highlight(selector: string, worktreeId?: string): Promise<unknown> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return await this.execAgentBrowser(sessionName, ['highlight', selector])
    })
  }

  async back(worktreeId?: string): Promise<BrowserBackResult> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['back'])) as BrowserBackResult
    })
  }

  async forward(worktreeId?: string): Promise<BrowserBackResult> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['forward'])) as BrowserBackResult
    })
  }

  async reload(worktreeId?: string): Promise<BrowserReloadResult> {
    // Why: reload can trigger a process swap in Electron (site-isolation), which
    // destroys the session mid-command. Use the webContents directly for reload
    // instead of going through agent-browser to avoid the session lifecycle issue.
    // Routed through enqueueCommand so it serializes with other in-flight commands.
    return this.enqueueCommand(worktreeId, async () => {
      const { webContentsId } = this.resolveActiveTab(worktreeId)
      const wc = this.getWebContents(webContentsId)
      if (!wc) {
        throw new BrowserError('browser_no_tab', 'Tab is no longer available')
      }
      wc.reload()
      await new Promise<void>((resolve) => {
        const onFinish = (): void => {
          wc.removeListener('did-finish-load', onFinish)
          wc.removeListener('did-fail-load', onFail)
          resolve()
        }
        const onFail = (): void => {
          wc.removeListener('did-finish-load', onFinish)
          wc.removeListener('did-fail-load', onFail)
          resolve()
        }
        wc.on('did-finish-load', onFinish)
        wc.on('did-fail-load', onFail)
        setTimeout(onFinish, 10_000)
      })
      return { url: wc.getURL(), title: wc.getTitle() }
    })
  }

  async screenshot(format?: string, worktreeId?: string): Promise<BrowserScreenshotResult> {
    // Why: agent-browser writes the screenshot to a temp file and returns
    // { "path": "/tmp/screenshot-xxx.png" }. We read the file and return base64.
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      const session = this.sessions.get(sessionName)
      const restore = session
        ? await this.browserManager.ensureWebviewVisible(session.webContentsId)
        : () => {}
      try {
        // Why: after focusing the window and unhiding the webview, the compositor
        // needs ~300ms to produce a painted frame. Without this delay capturePage()
        // returns a black/empty surface.
        await new Promise((r) => setTimeout(r, 300))
        const raw = await this.execAgentBrowser(sessionName, ['screenshot'])
        return this.readScreenshotFromResult(raw, format)
      } finally {
        restore()
      }
    })
  }

  async fullPageScreenshot(format?: string, worktreeId?: string): Promise<BrowserScreenshotResult> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      const session = this.sessions.get(sessionName)
      const restore = session
        ? await this.browserManager.ensureWebviewVisible(session.webContentsId)
        : () => {}
      try {
        await new Promise((r) => setTimeout(r, 300))
        const raw = await this.execAgentBrowser(sessionName, ['screenshot', '--full-page'])
        return this.readScreenshotFromResult(raw, format)
      } finally {
        restore()
      }
    })
  }

  private readScreenshotFromResult(raw: unknown, format?: string): BrowserScreenshotResult {
    const parsed = raw as { path?: string } | undefined
    if (!parsed?.path) {
      throw new BrowserError('browser_error', 'Screenshot returned no file path')
    }
    if (!existsSync(parsed.path)) {
      throw new BrowserError('browser_error', `Screenshot file not found: ${parsed.path}`)
    }
    const data = readFileSync(parsed.path).toString('base64')
    return { data, format: format === 'jpeg' ? 'jpeg' : 'png' } as BrowserScreenshotResult
  }

  async evaluate(expression: string, worktreeId?: string): Promise<BrowserEvalResult> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['eval', expression])) as BrowserEvalResult
    })
  }

  async hover(element: string, worktreeId?: string): Promise<BrowserHoverResult> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['hover', element])) as BrowserHoverResult
    })
  }

  async drag(from: string, to: string, worktreeId?: string): Promise<BrowserDragResult> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['drag', from, to])) as BrowserDragResult
    })
  }

  async upload(
    element: string,
    filePaths: string[],
    worktreeId?: string
  ): Promise<BrowserUploadResult> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, [
        'upload',
        element,
        ...filePaths
      ])) as BrowserUploadResult
    })
  }

  async wait(
    options?: {
      selector?: string
      timeout?: number
      text?: string
      url?: string
      load?: string
      fn?: string
      state?: string
    },
    worktreeId?: string
  ): Promise<BrowserWaitResult> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      const args = ['wait']
      if (options?.selector) {
        args.push(options.selector)
      } else if (options?.timeout != null) {
        args.push(String(options.timeout))
      }
      if (options?.text) {
        args.push('--text', options.text)
      }
      if (options?.url) {
        args.push('--url', options.url)
      }
      if (options?.load) {
        args.push('--load', options.load)
      }
      if (options?.fn) {
        args.push('--fn', options.fn)
      }
      if (options?.state) {
        args.push('--state', options.state)
      }
      return (await this.execAgentBrowser(sessionName, args)) as BrowserWaitResult
    })
  }

  async check(element: string, checked: boolean, worktreeId?: string): Promise<BrowserCheckResult> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      const args = checked ? ['check', element] : ['uncheck', element]
      return (await this.execAgentBrowser(sessionName, args)) as BrowserCheckResult
    })
  }

  async focus(element: string, worktreeId?: string): Promise<BrowserFocusResult> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['focus', element])) as BrowserFocusResult
    })
  }

  async clear(element: string, worktreeId?: string): Promise<BrowserClearResult> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      // Why: agent-browser has no clear command — use fill with empty string
      return (await this.execAgentBrowser(sessionName, ['fill', element, ''])) as BrowserClearResult
    })
  }

  async selectAll(element: string, worktreeId?: string): Promise<BrowserSelectAllResult> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      // Why: agent-browser has no select-all command — implement as focus + Ctrl+A
      await this.execAgentBrowser(sessionName, ['focus', element])
      return (await this.execAgentBrowser(sessionName, [
        'press',
        'Control+a'
      ])) as BrowserSelectAllResult
    })
  }

  async keypress(key: string, worktreeId?: string): Promise<BrowserKeypressResult> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['press', key])) as BrowserKeypressResult
    })
  }

  async pdf(worktreeId?: string): Promise<BrowserPdfResult> {
    // Why: agent-browser's pdf command via CDP Page.printToPDF hangs in Electron
    // webviews. Use Electron's native webContents.printToPDF() which is reliable.
    // Routed through enqueueCommand so it serializes with other in-flight commands.
    return this.enqueueCommand(worktreeId, async () => {
      const { webContentsId } = this.resolveActiveTab(worktreeId)
      const wc = this.getWebContents(webContentsId)
      if (!wc) {
        throw new BrowserError('browser_no_tab', 'Tab is no longer available')
      }
      const buffer = await wc.printToPDF({
        printBackground: true,
        preferCSSPageSize: true
      })
      return { data: buffer.toString('base64') }
    })
  }

  // ── Cookie commands ──

  async cookieGet(_url?: string, worktreeId?: string): Promise<BrowserCookieGetResult> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, [
        'cookies',
        'get'
      ])) as BrowserCookieGetResult
    })
  }

  async cookieSet(
    cookie: Partial<BrowserCookie>,
    worktreeId?: string
  ): Promise<BrowserCookieSetResult> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      const args = ['cookies', 'set', cookie.name ?? '', cookie.value ?? '']
      if (cookie.domain) {
        args.push('--domain', cookie.domain)
      }
      if (cookie.path) {
        args.push('--path', cookie.path)
      }
      if (cookie.secure) {
        args.push('--secure')
      }
      if (cookie.httpOnly) {
        args.push('--httpOnly')
      }
      if (cookie.sameSite) {
        args.push('--sameSite', cookie.sameSite)
      }
      if (cookie.expires != null) {
        args.push('--expires', String(cookie.expires))
      }
      return (await this.execAgentBrowser(sessionName, args)) as BrowserCookieSetResult
    })
  }

  async cookieDelete(
    name?: string,
    domain?: string,
    _url?: string,
    worktreeId?: string
  ): Promise<BrowserCookieDeleteResult> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      const args = ['cookies', 'clear']
      if (name) {
        args.push('--name', name)
      }
      if (domain) {
        args.push('--domain', domain)
      }
      return (await this.execAgentBrowser(sessionName, args)) as BrowserCookieDeleteResult
    })
  }

  // ── Viewport / emulation commands ──

  async setViewport(
    width: number,
    height: number,
    scale?: number,
    _mobile?: boolean,
    worktreeId?: string
  ): Promise<BrowserViewportResult> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      const args = ['set', 'viewport', String(width), String(height)]
      if (scale != null) {
        args.push(String(scale))
      }
      return (await this.execAgentBrowser(sessionName, args)) as BrowserViewportResult
    })
  }

  async setGeolocation(
    lat: number,
    lon: number,
    _accuracy?: number,
    worktreeId?: string
  ): Promise<BrowserGeolocationResult> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, [
        'set',
        'geo',
        String(lat),
        String(lon)
      ])) as BrowserGeolocationResult
    })
  }

  // ── Network interception commands ──

  async interceptEnable(
    patterns?: string[],
    worktreeId?: string
  ): Promise<BrowserInterceptEnableResult> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      // Why: agent-browser uses "network route <url>" to intercept. Route each pattern individually.
      const urlPattern = patterns?.[0] ?? '**/*'
      const args = ['network', 'route', urlPattern]
      const result = (await this.execAgentBrowser(
        sessionName,
        args
      )) as BrowserInterceptEnableResult
      const session = this.sessions.get(sessionName)
      if (session) {
        session.activeInterceptPatterns = patterns ?? ['*']
      }
      return result
    })
  }

  async interceptDisable(worktreeId?: string): Promise<BrowserInterceptDisableResult> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      const result = (await this.execAgentBrowser(sessionName, [
        'network',
        'unroute'
      ])) as BrowserInterceptDisableResult
      const session = this.sessions.get(sessionName)
      if (session) {
        session.activeInterceptPatterns = []
      }
      return result
    })
  }

  async interceptList(worktreeId?: string): Promise<{ requests: unknown[] }> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['network', 'requests'])) as {
        requests: unknown[]
      }
    })
  }

  async interceptContinue(
    _requestId: string,
    worktreeId?: string
  ): Promise<BrowserInterceptContinueResult> {
    // TODO: agent-browser doesn't support per-request continue — this removes all interception.
    // The CLI/RPC pass requestId but agent-browser only operates on URL patterns.
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, [
        'network',
        'unroute'
      ])) as BrowserInterceptContinueResult
    })
  }

  async interceptBlock(
    urlPattern: string,
    _reason?: string,
    worktreeId?: string
  ): Promise<BrowserInterceptBlockResult> {
    // TODO: RPC passes requestId as urlPattern — agent-browser expects a URL glob, not a request ID.
    // This is a design mismatch that needs reworking at the CLI/RPC/bridge level.
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, [
        'network',
        'route',
        urlPattern,
        '--abort'
      ])) as BrowserInterceptBlockResult
    })
  }

  // ── Capture commands ──

  async captureStart(worktreeId?: string): Promise<BrowserCaptureStartResult> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      const result = (await this.execAgentBrowser(sessionName, [
        'network',
        'har',
        'start'
      ])) as BrowserCaptureStartResult
      const session = this.sessions.get(sessionName)
      if (session) {
        session.activeCapture = true
      }
      return result
    })
  }

  async captureStop(worktreeId?: string): Promise<BrowserCaptureStopResult> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      const result = (await this.execAgentBrowser(sessionName, [
        'network',
        'har',
        'stop'
      ])) as BrowserCaptureStopResult
      const session = this.sessions.get(sessionName)
      if (session) {
        session.activeCapture = false
      }
      return result
    })
  }

  async consoleLog(_limit?: number, worktreeId?: string): Promise<BrowserConsoleResult> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['console'])) as BrowserConsoleResult
    })
  }

  async networkLog(_limit?: number, worktreeId?: string): Promise<BrowserNetworkLogResult> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, [
        'network',
        'requests'
      ])) as BrowserNetworkLogResult
    })
  }

  // ── Generic passthrough ──

  async exec(command: string, worktreeId?: string): Promise<unknown> {
    return this.enqueueCommand(worktreeId, async (sessionName) => {
      // Why: strip --cdp and --session from raw command to prevent session/target injection
      const sanitized = command
        .replace(/--cdp\s+\S+/g, '')
        .replace(/--session\s+\S+/g, '')
        .trim()
      const args = parseShellArgs(sanitized)
      return await this.execAgentBrowser(sessionName, args)
    })
  }

  // ── Session lifecycle ──

  async destroyAllSessions(): Promise<void> {
    const promises: Promise<void>[] = []
    for (const sessionName of this.sessions.keys()) {
      promises.push(this.destroySession(sessionName))
    }
    await Promise.allSettled(promises)
  }

  // ── Internal ──

  private async enqueueCommand<T>(
    worktreeId: string | undefined,
    execute: (sessionName: string) => Promise<T>
  ): Promise<T> {
    const { browserPageId, webContentsId } = this.resolveActiveTab(worktreeId)
    const sessionName = `orca-tab-${browserPageId}`

    await this.ensureSession(sessionName, browserPageId, webContentsId)

    return new Promise<T>((resolve, reject) => {
      let queue = this.commandQueues.get(sessionName)
      if (!queue) {
        queue = []
        this.commandQueues.set(sessionName, queue)
      }
      queue.push({
        execute: (() => execute(sessionName)) as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject
      })
      this.processQueue(sessionName)
    })
  }

  private async processQueue(sessionName: string): Promise<void> {
    if (this.processingQueues.has(sessionName)) {
      return
    }
    this.processingQueues.add(sessionName)

    const queue = this.commandQueues.get(sessionName)
    while (queue && queue.length > 0) {
      const cmd = queue.shift()!
      try {
        const result = await cmd.execute()
        cmd.resolve(result)
      } catch (error) {
        cmd.reject(error)
      }
    }

    this.processingQueues.delete(sessionName)
  }

  private resolveActiveTab(worktreeId?: string): { browserPageId: string; webContentsId: number } {
    const tabs = this.getRegisteredTabs(worktreeId)

    if (tabs.size === 0) {
      throw new BrowserError('browser_no_tab', 'No browser tab open in this worktree')
    }

    // Why: prefer per-worktree active tab to prevent cross-worktree interference.
    // Fall back to global activeWebContentsId for callers that don't pass worktreeId.
    const preferredWcId =
      (worktreeId && this.activeWebContentsPerWorktree.get(worktreeId)) ?? this.activeWebContentsId

    if (preferredWcId != null) {
      for (const [tabId, wcId] of tabs) {
        if (wcId === preferredWcId && this.getWebContents(wcId)) {
          return { browserPageId: tabId, webContentsId: wcId }
        }
      }
    }

    // Why: persisted store state can leave ghost tabs whose webContents no longer exist.
    // Skip those and pick the first live tab. Also activate it so tabList and
    // subsequent resolveActiveTab calls are consistent without requiring an
    // explicit tab switch after app startup.
    for (const [tabId, wcId] of tabs) {
      if (this.getWebContents(wcId)) {
        this.activeWebContentsId = wcId
        if (worktreeId) {
          this.activeWebContentsPerWorktree.set(worktreeId, wcId)
        }
        return { browserPageId: tabId, webContentsId: wcId }
      }
    }

    throw new BrowserError(
      'browser_no_tab',
      'No live browser tab available — all registered tabs have been destroyed'
    )
  }

  private async ensureSession(
    sessionName: string,
    _browserPageId: string,
    webContentsId: number
  ): Promise<void> {
    if (this.sessions.has(sessionName)) {
      return
    }

    // Why: two concurrent CLI calls can both reach here before either finishes
    // creating the session. Without this lock, both would create proxies and the
    // second would overwrite the first, leaking the first proxy's server/debugger.
    const pending = this.pendingSessionCreation.get(sessionName)
    if (pending) {
      await pending
      return
    }

    const createSession = async (): Promise<void> => {
      const wc = this.getWebContents(webContentsId)
      if (!wc) {
        throw new BrowserError('browser_no_tab', 'Tab is no longer available')
      }

      // Why: agent-browser's daemon persists session state (including the CDP port)
      // across Orca restarts. A stale session would try to connect to a dead port.
      // Fire-and-forget with a short timeout — never block session creation on cleanup.
      execFile(
        this.agentBrowserBin,
        ['--session', sessionName, 'close'],
        { timeout: 3000 },
        () => {}
      )

      const proxy = new CdpWsProxy(wc)
      const cdpEndpoint = await proxy.start()

      this.sessions.set(sessionName, {
        proxy,
        cdpEndpoint,
        initialized: false,
        consecutiveTimeouts: 0,
        activeInterceptPatterns: [],
        activeCapture: false,
        webContentsId
      })
    }

    const promise = createSession()
    this.pendingSessionCreation.set(sessionName, promise)
    try {
      await promise
    } finally {
      this.pendingSessionCreation.delete(sessionName)
    }
  }

  private async destroySession(sessionName: string): Promise<void> {
    const session = this.sessions.get(sessionName)
    if (!session) {
      return
    }

    this.sessions.delete(sessionName)
    this.pendingSessionCreation.delete(sessionName)

    // Why: queued commands would hang forever if we just delete the queue —
    // their promises would never resolve or reject. Drain and reject them.
    const queue = this.commandQueues.get(sessionName)
    this.commandQueues.delete(sessionName)
    this.processingQueues.delete(sessionName)
    if (queue) {
      const err = new BrowserError('browser_error', 'Session destroyed while commands were queued')
      for (const cmd of queue) {
        cmd.reject(err)
      }
    }

    try {
      await this.runAgentBrowserRaw(sessionName, ['close'])
    } catch {
      // Session may already be dead
    }

    await session.proxy.stop()
  }

  private async execAgentBrowser(sessionName: string, commandArgs: string[]): Promise<unknown> {
    const session = this.sessions.get(sessionName)
    if (!session) {
      throw new BrowserError('browser_error', 'Session not found')
    }

    // Why: between enqueue time and execution time (queue delay), the webContents
    // could be destroyed. Check here to give a clear error instead of letting the
    // proxy fail with cryptic Electron debugger errors.
    if (!this.getWebContents(session.webContentsId)) {
      throw new BrowserError('browser_tab_closed', 'Tab was closed while command was queued')
    }

    const args = ['--session', sessionName]

    // Why: --cdp is session-initialization only — first command needs it, subsequent don't.
    // Pass as port number (not ws:// URL) so agent-browser hits the proxy's HTTP /json
    // endpoint for target discovery. The proxy only exposes the webview, preventing
    // agent-browser from picking the host renderer page.
    const needsInit = !session.initialized
    if (needsInit) {
      const port = session.proxy.getPort()
      args.push('--cdp', String(port))
    }

    args.push(...commandArgs, '--json')

    const stdout = await this.runAgentBrowserRaw(sessionName, args)
    const translated = translateResult(stdout)

    if (!translated.ok) {
      throw new BrowserError(translated.error.code, translated.error.message)
    }

    // Why: only mark initialized after a successful command — if the first --cdp
    // connection fails, the next attempt should retry with --cdp.
    if (needsInit) {
      session.initialized = true

      // Why: after a process swap, intercept patterns are lost because the session
      // was destroyed and recreated. Restore them now that the new session is live.
      const pendingPatterns = this.pendingInterceptRestore.get(sessionName)
      if (pendingPatterns && pendingPatterns.length > 0) {
        this.pendingInterceptRestore.delete(sessionName)
        try {
          const urlPattern = pendingPatterns[0] ?? '**/*'
          await this.runAgentBrowserRaw(sessionName, [
            '--session',
            sessionName,
            'network',
            'route',
            urlPattern,
            '--json'
          ])
          session.activeInterceptPatterns = pendingPatterns
        } catch {
          // Why: intercept restore is best-effort — don't fail the user's command
          // if the new page doesn't support the same interception setup.
        }
      }
    }

    return translated.result
  }

  private runAgentBrowserRaw(sessionName: string, args: string[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      execFile(
        this.agentBrowserBin,
        args,
        // Why: screenshots return large base64 strings that exceed Node's default
        // 1MB maxBuffer, causing ENOBUFS and a timeout-like failure.
        { timeout: EXEC_TIMEOUT_MS, maxBuffer: 50 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const session = this.sessions.get(sessionName)

          if (error && (error as NodeJS.ErrnoException & { killed?: boolean }).killed) {
            if (session) {
              session.consecutiveTimeouts++
              if (session.consecutiveTimeouts >= CONSECUTIVE_TIMEOUT_LIMIT) {
                // Why: 3 consecutive timeouts means the daemon is likely stuck — destroy and recreate
                this.destroySession(sessionName)
              }
            }
            reject(new BrowserError('browser_error', 'Browser command timed out'))
            return
          }

          if (session) {
            session.consecutiveTimeouts = 0
          }

          if (error) {
            // Why: agent-browser exits non-zero for command failures (e.g. clipboard
            // NotAllowedError) but still writes structured JSON to stdout. Parse it
            // so callers get the real error message instead of generic "Command failed".
            if (stdout) {
              try {
                const parsed = JSON.parse(stdout)
                if (parsed.error) {
                  reject(new BrowserError(classifyErrorCode(parsed.error), parsed.error))
                  return
                }
              } catch {
                // stdout not valid JSON — fall through to stderr/error.message
              }
            }
            reject(new BrowserError('browser_error', stderr || error.message))
            return
          }

          resolve(stdout)
        }
      )
    })
  }

  private resolveTabIdSafe(webContentsId: number): string | null {
    const tabs = this.browserManager.getWebContentsIdByTabId()
    for (const [tabId, wcId] of tabs) {
      if (wcId === webContentsId) {
        return tabId
      }
    }
    return null
  }

  private getWebContents(webContentsId: number): Electron.WebContents | null {
    try {
      const { webContents } = require('electron')
      return webContents.fromId(webContentsId) ?? null
    } catch {
      return null
    }
  }
}
