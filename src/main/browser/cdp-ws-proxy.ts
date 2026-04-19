import { WebSocketServer, WebSocket } from 'ws'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import type { WebContents } from 'electron'

/**
 * Per-tab WebSocket proxy bridging agent-browser's CDP client connection
 * to Electron's webContents.debugger API.
 *
 * Not a transparent forwarder — handles CDP message ID correlation,
 * sessionId envelope translation for OOPIFs, and event forwarding.
 *
 * Also serves HTTP /json endpoints so agent-browser's target discovery
 * only sees the proxied webview (not the host renderer).
 */
export class CdpWsProxy {
  private httpServer: Server | null = null
  private wss: WebSocketServer | null = null
  private client: WebSocket | null = null
  private port = 0
  private nextId = 1
  private readonly inflight = new Map<
    number,
    { clientId: number; resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()
  private debuggerMessageHandler: ((...args: unknown[]) => void) | null = null
  private debuggerDetachHandler: ((...args: unknown[]) => void) | null = null
  private attached = false
  // Why: when agent-browser attaches via Target.attachToTarget, it expects all events
  // to carry the returned sessionId. We track it here so the event forwarder can tag
  // events with the correct sessionId that agent-browser filters on.
  private clientSessionId: string | undefined = undefined

  constructor(private readonly webContents: WebContents) {}

  async start(): Promise<string> {
    await this.attachDebugger()

    return new Promise<string>((resolve, reject) => {
      this.httpServer = createServer((req, res) => this.handleHttpRequest(req, res))
      this.wss = new WebSocketServer({ server: this.httpServer })

      this.wss.on('connection', (ws) => {
        // Single-client: replace any previous connection
        if (this.client) {
          this.client.close()
        }
        this.client = ws

        ws.on('message', (data) => {
          this.handleClientMessage(data.toString())
        })

        ws.on('close', () => {
          if (this.client === ws) {
            this.client = null
          }
        })
      })

      this.httpServer.listen(0, '127.0.0.1', () => {
        const addr = this.httpServer!.address()
        if (typeof addr === 'object' && addr) {
          this.port = addr.port
          resolve(`ws://127.0.0.1:${this.port}`)
        } else {
          reject(new Error('Failed to bind proxy server'))
        }
      })

      this.httpServer.on('error', reject)
    })
  }

  async stop(): Promise<void> {
    this.detachDebugger()

    if (this.client) {
      this.client.close()
      this.client = null
    }
    if (this.wss) {
      this.wss.close()
      this.wss = null
    }
    if (this.httpServer) {
      this.httpServer.close()
      this.httpServer = null
    }

    for (const { reject } of this.inflight.values()) {
      reject(new Error('Proxy stopped'))
    }
    this.inflight.clear()
  }

  getPort(): number {
    return this.port
  }

  // Why: agent-browser (and Playwright) discover CDP targets via HTTP before
  // connecting the WebSocket. Serving /json with only the proxied webview
  // ensures agent-browser attaches to the correct target instead of picking
  // the Orca renderer page.
  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? ''

    if (url === '/json/version' || url === '/json/version/') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          Browser: 'Orca/CdpWsProxy',
          'Protocol-Version': '1.3',
          webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}`
        })
      )
      return
    }

    if (url === '/json' || url === '/json/' || url === '/json/list' || url === '/json/list/') {
      const pageUrl = this.webContents.isDestroyed() ? '' : this.webContents.getURL()
      const pageTitle = this.webContents.isDestroyed() ? '' : this.webContents.getTitle()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify([
          {
            id: 'orca-proxy-target',
            type: 'page',
            title: pageTitle,
            url: pageUrl,
            webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}`
          }
        ])
      )
      return
    }

    res.writeHead(404)
    res.end()
  }

  private async attachDebugger(): Promise<void> {
    if (this.attached) {
      return
    }

    try {
      this.webContents.debugger.attach('1.3')
    } catch {
      throw new Error('Could not attach debugger. DevTools may already be open for this tab.')
    }
    this.attached = true

    this.debuggerMessageHandler = (_event: unknown, ...rest: unknown[]) => {
      const [method, params, sessionId] = rest as [
        string,
        Record<string, unknown>,
        string | undefined
      ]
      if (!this.client || this.client.readyState !== WebSocket.OPEN) {
        return
      }

      // Why: events from the root debugger session have no sessionId, but agent-browser
      // expects them tagged with the sessionId returned from Target.attachToTarget.
      // Without this, agent-browser drops events and commands like goto hang forever.
      const msg: Record<string, unknown> = { method, params }
      if (sessionId) {
        msg.sessionId = sessionId
      } else if (this.clientSessionId) {
        msg.sessionId = this.clientSessionId
      }
      this.client.send(JSON.stringify(msg))
    }

    this.debuggerDetachHandler = () => {
      this.attached = false
      this.stop()
    }

    this.webContents.debugger.on('message', this.debuggerMessageHandler as never)
    this.webContents.debugger.on('detach', this.debuggerDetachHandler as never)
  }

  private detachDebugger(): void {
    if (this.debuggerMessageHandler) {
      this.webContents.debugger.removeListener('message', this.debuggerMessageHandler as never)
      this.debuggerMessageHandler = null
    }
    if (this.debuggerDetachHandler) {
      this.webContents.debugger.removeListener('detach', this.debuggerDetachHandler as never)
      this.debuggerDetachHandler = null
    }
    if (this.attached) {
      try {
        this.webContents.debugger.detach()
      } catch {
        // Already detached
      }
      this.attached = false
    }
  }

  private handleClientMessage(raw: string): void {
    let msg: { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }

    if (msg.id == null || !msg.method) {
      return
    }

    const clientId = msg.id

    // Why: Target.getTargets() is browser-level — even when the debugger is attached
    // to the webview, it returns ALL targets (including the Orca renderer). Intercept
    // and return only the proxied webview so agent-browser doesn't discover/switch to
    // the wrong target.
    if (msg.method === 'Target.getTargets') {
      const targetInfo = {
        targetId: 'orca-proxy-target',
        type: 'page',
        title: this.webContents.isDestroyed() ? '' : this.webContents.getTitle(),
        url: this.webContents.isDestroyed() ? '' : this.webContents.getURL(),
        attached: true,
        canAccessOpener: false
      }
      if (this.client?.readyState === WebSocket.OPEN) {
        this.client.send(JSON.stringify({ id: clientId, result: { targetInfos: [targetInfo] } }))
      }
      return
    }

    // Why: Target.setDiscoverTargets would cause the proxy to emit Target.targetCreated
    // events for all browser targets. Acknowledge it without forwarding.
    if (msg.method === 'Target.setDiscoverTargets') {
      if (this.client?.readyState === WebSocket.OPEN) {
        this.client.send(JSON.stringify({ id: clientId, result: {} }))
      }
      return
    }

    // Why: agent-browser calls attachToTarget after discovering our synthetic target ID.
    // Since the proxy WebSocket is already directly connected to the webview's debugger,
    // no real attachment is needed. Return a synthetic sessionId so agent-browser can
    // correlate events. We tag forwarded events with this same sessionId.
    if (msg.method === 'Target.attachToTarget') {
      this.clientSessionId = 'orca-proxy-session'
      if (this.client?.readyState === WebSocket.OPEN) {
        this.client.send(
          JSON.stringify({ id: clientId, result: { sessionId: this.clientSessionId } })
        )
      }
      return
    }

    // Why: Target.getTargetInfo returns info for a single target — return our synthetic
    // target consistent with getTargets to prevent agent-browser from seeing other targets.
    if (msg.method === 'Target.getTargetInfo') {
      const targetInfo = {
        targetId: 'orca-proxy-target',
        type: 'page',
        title: this.webContents.isDestroyed() ? '' : this.webContents.getTitle(),
        url: this.webContents.isDestroyed() ? '' : this.webContents.getURL(),
        attached: true,
        canAccessOpener: false
      }
      if (this.client?.readyState === WebSocket.OPEN) {
        this.client.send(JSON.stringify({ id: clientId, result: { targetInfo } }))
      }
      return
    }

    // Why: agent-browser may call detachFromTarget during cleanup. Since our attachment
    // is synthetic, acknowledge without forwarding.
    if (msg.method === 'Target.detachFromTarget') {
      this.clientSessionId = undefined
      if (this.client?.readyState === WebSocket.OPEN) {
        this.client.send(JSON.stringify({ id: clientId, result: {} }))
      }
      return
    }

    // Why: Browser.getVersion is browser-level and would fail through Electron's
    // per-tab debugger. Return a synthetic response matching Chrome's format.
    if (msg.method === 'Browser.getVersion') {
      if (this.client?.readyState === WebSocket.OPEN) {
        this.client.send(
          JSON.stringify({
            id: clientId,
            result: {
              protocolVersion: '1.3',
              product: 'Orca/Electron',
              userAgent: '',
              jsVersion: ''
            }
          })
        )
      }
      return
    }

    // Why: Page.bringToFront gives document focus which is required for
    // navigator.clipboard API. Electron's debugger doesn't handle this —
    // we must call webContents.focus() at the native level.
    if (msg.method === 'Page.bringToFront') {
      if (!this.webContents.isDestroyed()) {
        this.webContents.focus()
      }
      if (this.client?.readyState === WebSocket.OPEN) {
        this.client.send(JSON.stringify({ id: clientId, result: {} }))
      }
      return
    }

    // Why: focus-dependent APIs (navigator.clipboard, etc.) require document.hasFocus()
    // to return true. In Electron, the webview doesn't automatically have focus since
    // it's a background guest. Ensure focus before any JS evaluation so clipboard and
    // similar APIs work without the "Document is not focused" error.
    if (msg.method === 'Runtime.evaluate' && !this.webContents.isDestroyed()) {
      this.webContents.focus()
    }

    const internalId = this.nextId++

    // Why: our Target.attachToTarget intercept returns a synthetic sessionId so
    // agent-browser includes it in all subsequent commands. Electron only knows about
    // real sessions — strip the synthetic one so commands route to the root session.
    const sessionId =
      msg.sessionId && msg.sessionId !== this.clientSessionId ? msg.sessionId : undefined

    this.webContents.debugger
      .sendCommand(msg.method, msg.params ?? {}, sessionId)
      .then((result) => {
        this.inflight.delete(internalId)
        if (this.client?.readyState === WebSocket.OPEN) {
          this.client.send(JSON.stringify({ id: clientId, result }))
        }
      })
      .catch((err: Error) => {
        this.inflight.delete(internalId)
        if (this.client?.readyState === WebSocket.OPEN) {
          this.client.send(
            JSON.stringify({
              id: clientId,
              error: { code: -32000, message: err.message }
            })
          )
        }
      })

    this.inflight.set(internalId, {
      clientId,
      resolve: () => {},
      reject: () => {}
    })
  }
}
