import { WebSocketServer, WebSocket } from 'ws'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import type { WebContents } from 'electron'

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
        if (this.client) {
          this.client.close()
        }
        this.client = ws
        ws.on('message', (data) => this.handleClientMessage(data.toString()))
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

  private sendResult(clientId: number, result: unknown): void {
    if (this.client?.readyState === WebSocket.OPEN) {
      this.client.send(JSON.stringify({ id: clientId, result }))
    }
  }

  private sendError(clientId: number, message: string): void {
    if (this.client?.readyState === WebSocket.OPEN) {
      this.client.send(JSON.stringify({ id: clientId, error: { code: -32000, message } }))
    }
  }

  private buildTargetInfo(): Record<string, unknown> {
    const destroyed = this.webContents.isDestroyed()
    return {
      targetId: 'orca-proxy-target',
      type: 'page',
      title: destroyed ? '' : this.webContents.getTitle(),
      url: destroyed ? '' : this.webContents.getURL(),
      attached: true,
      canAccessOpener: false
    }
  }

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
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify([
          {
            ...this.buildTargetInfo(),
            id: 'orca-proxy-target',
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

    if (!this.webContents.debugger.isAttached()) {
      try {
        this.webContents.debugger.attach('1.3')
      } catch {
        throw new Error('Could not attach debugger. DevTools may already be open for this tab.')
      }
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
      const msg: Record<string, unknown> = { method, params }
      msg.sessionId = sessionId ?? this.clientSessionId
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
        /* already detached */
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

    // Why: Target.* and Browser.* commands are browser-level. Electron's per-tab
    // debugger can't handle them. Intercept with synthetic responses so agent-browser
    // sees only the proxied webview target.
    if (msg.method === 'Target.getTargets') {
      this.sendResult(clientId, { targetInfos: [this.buildTargetInfo()] })
      return
    }
    if (msg.method === 'Target.getTargetInfo') {
      this.sendResult(clientId, { targetInfo: this.buildTargetInfo() })
      return
    }
    if (msg.method === 'Target.setDiscoverTargets' || msg.method === 'Target.detachFromTarget') {
      if (msg.method === 'Target.detachFromTarget') {
        this.clientSessionId = undefined
      }
      this.sendResult(clientId, {})
      return
    }
    if (msg.method === 'Target.attachToTarget') {
      this.clientSessionId = 'orca-proxy-session'
      this.sendResult(clientId, { sessionId: this.clientSessionId })
      return
    }
    if (msg.method === 'Browser.getVersion') {
      this.sendResult(clientId, {
        protocolVersion: '1.3',
        product: 'Orca/Electron',
        userAgent: '',
        jsVersion: ''
      })
      return
    }
    if (msg.method === 'Page.bringToFront') {
      if (!this.webContents.isDestroyed()) {
        this.webContents.focus()
      }
      this.sendResult(clientId, {})
      return
    }

    // Why: Page.captureScreenshot via wc.debugger.sendCommand hangs on Electron
    // webview guests. Intercept and use capturePage() instead.
    if (msg.method === 'Page.captureScreenshot') {
      this.handleScreenshot(clientId, msg.params)
      return
    }

    // Why: Input.insertText requires native focus; Runtime.evaluate/callFunctionOn
    // need focus for clipboard APIs. dispatchKeyEvent must NOT trigger focus here.
    if (
      (msg.method === 'Input.insertText' ||
        msg.method === 'Runtime.evaluate' ||
        msg.method === 'Runtime.callFunctionOn') &&
      !this.webContents.isDestroyed()
    ) {
      this.webContents.focus()
    }

    const internalId = this.nextId++
    // Why: strip synthetic sessionId so commands route to Electron's root session.
    const sessionId =
      msg.sessionId && msg.sessionId !== this.clientSessionId ? msg.sessionId : undefined

    this.webContents.debugger
      .sendCommand(msg.method, msg.params ?? {}, sessionId)
      .then((result) => {
        this.inflight.delete(internalId)
        this.sendResult(clientId, result)
      })
      .catch((err: Error) => {
        this.inflight.delete(internalId)
        this.sendError(clientId, err.message)
      })

    this.inflight.set(internalId, { clientId, resolve: () => {}, reject: () => {} })
  }

  // Why: Electron's wc.debugger.sendCommand('Page.captureScreenshot') hangs
  // indefinitely on webview guest processes. The bridge calls ensureWebviewVisible
  // before the command reaches here. Retry to tolerate slow compositing.
  private handleScreenshot(clientId: number, params?: Record<string, unknown>): void {
    if (this.webContents.isDestroyed()) {
      this.sendError(clientId, 'WebContents destroyed')
      return
    }
    const format = (params?.format as string) ?? 'png'

    const attemptCapture = async (retries: number): Promise<void> => {
      try {
        if (this.webContents.isDestroyed()) {
          this.sendError(clientId, 'WebContents destroyed')
          return
        }
        const image = await this.webContents.capturePage()
        if (image.isEmpty()) {
          if (retries > 0) {
            setTimeout(() => attemptCapture(retries - 1), 200)
            return
          }
          this.sendError(
            clientId,
            'Screenshot captured an empty image — the browser tab may not be visible in the Orca UI.'
          )
          return
        }
        const data =
          format === 'jpeg' ? image.toJPEG(80).toString('base64') : image.toPNG().toString('base64')
        this.sendResult(clientId, { data })
      } catch (err) {
        this.sendError(clientId, (err as Error).message)
      }
    }

    setTimeout(() => attemptCapture(3), 100)
  }
}
