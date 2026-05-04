/* eslint-disable max-lines -- Why: this file is the single security boundary for the bundled CLI — transport setup, auth-token enforcement, admission control, keepalive framing, and orphan-socket sweeping all co-locate deliberately so a reviewer can audit the boundary in one sitting. Splitting this across files would scatter the invariants without reducing complexity. */
// Why: this is the single security boundary for the bundled CLI. It owns
// transport setup (unix socket / named pipe), auth-token enforcement, and
// bootstrap-metadata publication so a running runtime is always discoverable
// via exactly one on-disk file. Method handling lives in `rpc/` so this file
// stays easy to audit in one sitting.
import { randomBytes } from 'crypto'
import { createServer, type Server, type Socket } from 'net'
import { chmodSync, existsSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import type { RuntimeMetadata, RuntimeTransportMetadata } from '../../shared/runtime-bootstrap'
import type { OrcaRuntimeService } from './orca-runtime'
import { writeRuntimeMetadata } from './runtime-metadata'
import { RpcDispatcher } from './rpc/dispatcher'
import type { RpcRequest, RpcResponse } from './rpc/core'
import { errorResponse } from './rpc/errors'

type OrcaRuntimeRpcServerOptions = {
  runtime: OrcaRuntimeService
  userDataPath: string
  pid?: number
  platform?: NodeJS.Platform
  // Why: test-only overrides for the two time-bound constants below.
  // Production callers must not pass these — defaults are set by the design
  // doc (§3.1) and changing them in production would weaken the admission
  // fence or flood the socket with keepalive frames.
  keepaliveIntervalMs?: number
  longPollCap?: number
}

const MAX_RUNTIME_RPC_MESSAGE_BYTES = 1024 * 1024
const RUNTIME_RPC_SOCKET_IDLE_TIMEOUT_MS = 30_000
const MAX_RUNTIME_RPC_CONNECTIONS = 32

// Why: after 10 s of a pending dispatch we emit a tiny `{"_keepalive":true}`
// frame every 10 s until the handler resolves. Each write resets both the
// server's own socket idle timer (30 s) and — once §3.1 ships on the client —
// the client's idle timer, because any byte counts as socket activity. This
// is the transport-layer fix for feedback #1: long-poll RPCs (i.e.
// orchestration.check --wait) can now run past the 30 s/60 s idle caps
// without either end tearing the socket down. See design doc §3.1.
const KEEPALIVE_INTERVAL_MS = 10_000

// Why: long-poll slot cap. With keepalives a `check --wait --timeout-ms
// 600000` can hold a connection for up to 10 minutes; unbounded that would
// saturate MAX_RUNTIME_RPC_CONNECTIONS (32) with 32 waiting coordinators
// and lock out normal short RPCs. Capping at half the connection budget
// leaves the other half for short traffic. On overflow the server responds
// immediately with `runtime_busy` (CLI exit 75) — fail fast, not silent
// queuing. See design doc §3.1 + §7 risk #2.
const LONG_POLL_CAP = 16

// Why: a long-poll request is one whose handler blocks for an unbounded
// amount of time waiting for an external event (today, only
// `orchestration.check` with `wait === true`). This function is the single
// place that classifies it — the long-poll counter, abort wiring, and
// runtime_busy admission check all share this decision. See §3.1.
function isLongPollRequest(request: RpcRequest): boolean {
  if (request.method !== 'orchestration.check') {
    return false
  }
  const params = request.params as { wait?: unknown } | undefined
  return params?.wait === true
}

export class OrcaRuntimeRpcServer {
  private readonly runtime: OrcaRuntimeService
  private readonly dispatcher: RpcDispatcher
  private readonly userDataPath: string
  private readonly pid: number
  private readonly platform: NodeJS.Platform
  private readonly authToken = randomBytes(24).toString('hex')
  private readonly keepaliveIntervalMs: number
  private readonly longPollCap: number
  private server: Server | null = null
  private transport: RuntimeTransportMetadata | null = null
  // Why: separate from Node's server.maxConnections because we need to count
  // only long-running dispatches, not every in-flight short RPC. See §3.1 +
  // §7 risk #2.
  private activeLongPolls = 0

  constructor({
    runtime,
    userDataPath,
    pid = process.pid,
    platform = process.platform,
    keepaliveIntervalMs = KEEPALIVE_INTERVAL_MS,
    longPollCap = LONG_POLL_CAP
  }: OrcaRuntimeRpcServerOptions) {
    this.runtime = runtime
    this.dispatcher = new RpcDispatcher({ runtime })
    this.userDataPath = userDataPath
    this.pid = pid
    this.platform = platform
    this.keepaliveIntervalMs = keepaliveIntervalMs
    this.longPollCap = longPollCap
  }

  async start(): Promise<void> {
    if (this.server) {
      return
    }

    // Why: processes killed by SIGKILL / OOM-kill / forced-shutdown skip
    // stop() and leave behind `o-<pid>-*.sock` files in userData. Sweeping
    // dead-pid sockets at startup keeps the directory from accumulating
    // orphans over the app's lifetime. Named-pipe transports on Windows do
    // not leave filesystem entries in userData, so the sweep is a no-op
    // there.
    if (this.platform !== 'win32') {
      sweepOrphanedRuntimeSockets(this.userDataPath, this.pid)
    }

    const transport = createRuntimeTransportMetadata(
      this.userDataPath,
      this.pid,
      this.platform,
      this.runtime.getRuntimeId()
    )
    if (transport.kind === 'unix' && existsSync(transport.endpoint)) {
      rmSync(transport.endpoint, { force: true })
    }

    const server = createServer((socket) => {
      this.handleConnection(socket)
    })
    server.maxConnections = MAX_RUNTIME_RPC_CONNECTIONS

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(transport.endpoint, () => {
        server.off('error', reject)
        resolve()
      })
    })
    if (transport.kind === 'unix') {
      chmodSync(transport.endpoint, 0o600)
    }

    // Why: publish the transport into in-memory state before writing metadata
    // so the bootstrap file always contains the real endpoint/token pair. The
    // CLI only discovers the runtime through that file.
    this.server = server
    this.transport = transport

    try {
      this.writeMetadata()
    } catch (error) {
      // Why: a runtime that cannot publish bootstrap metadata is invisible to
      // the `orca` CLI. Close the socket immediately instead of leaving behind
      // a live but undiscoverable control plane.
      this.server = null
      this.transport = null
      await new Promise<void>((resolve, reject) => {
        server.close((closeError) => {
          if (closeError) {
            reject(closeError)
            return
          }
          resolve()
        })
      }).catch(() => {})
      if (transport.kind === 'unix' && existsSync(transport.endpoint)) {
        rmSync(transport.endpoint, { force: true })
      }
      throw error
    }
  }

  async stop(): Promise<void> {
    const server = this.server
    const transport = this.transport
    this.server = null
    this.transport = null
    if (!server) {
      return
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
    if (transport?.kind === 'unix' && existsSync(transport.endpoint)) {
      rmSync(transport.endpoint, { force: true })
    }
    // Why: we intentionally leave the last metadata file behind instead of
    // deleting it on shutdown. Shared userData paths can briefly host multiple
    // Orca processes during restarts, updates, or development, and stale
    // metadata is safer than letting one process erase another live runtime's
    // bootstrap file.
  }

  private handleConnection(socket: Socket): void {
    let buffer = ''

    socket.setEncoding('utf8')
    socket.setNoDelay(true)
    socket.setTimeout(RUNTIME_RPC_SOCKET_IDLE_TIMEOUT_MS, () => {
      socket.destroy()
    })
    socket.on('error', () => {
      socket.destroy()
    })
    socket.on('data', (chunk: string) => {
      buffer += chunk
      // Why: the Orca runtime lives in Electron main, so it must reject
      // oversized local RPC frames instead of letting a local client grow an
      // unbounded buffer and stall the app.
      if (Buffer.byteLength(buffer, 'utf8') > MAX_RUNTIME_RPC_MESSAGE_BYTES) {
        socket.write(
          `${JSON.stringify(this.buildError('unknown', 'request_too_large', 'RPC request exceeds the maximum size'))}\n`
        )
        socket.end()
        return
      }
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const rawMessage = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        if (rawMessage) {
          void this.handleRequest(socket, rawMessage)
        }
        newlineIndex = buffer.indexOf('\n')
      }
    })
  }

  // Why: a single entry point per inbound request so keepalive + long-poll
  // admission + AbortController wiring + response write all live in one
  // place. See design doc §3.1.
  private async handleRequest(socket: Socket, rawMessage: string): Promise<void> {
    const parsed = this.parseAndAuth(rawMessage)
    if ('error' in parsed) {
      this.safeWrite(socket, `${JSON.stringify(parsed.error)}\n`)
      return
    }
    const request = parsed.request

    // Why: long-poll admission fence. Short RPCs bypass the counter entirely
    // — it only guards handlers that can block for minutes. See §7 risk #2.
    const longPoll = isLongPollRequest(request)
    if (longPoll) {
      if (this.activeLongPolls >= this.longPollCap) {
        const busy = this.buildError(
          request.id,
          'runtime_busy',
          'long-poll capacity reached; retry with backoff'
        )
        this.safeWrite(socket, `${JSON.stringify(busy)}\n`)
        socket.end()
        return
      }
      this.activeLongPolls += 1
    }

    // Why: `decremented` must guard against double-decrement when both
    // `close` and a post-resolve cleanup path fire. `socket.on('close')` is
    // the only path that fires for every termination (normal end, destroy,
    // idle timer, client kill -9, OS reset), so it carries the decrement.
    // Tying it to `.finally` alone would leak a slot any time a client dies
    // mid-wait because the inner waitForMessage can keep counting down for
    // minutes after the socket is gone. See §3.1 counter-lifecycle.
    let decremented = !longPoll
    const abortController = new AbortController()
    const onClose = (): void => {
      if (!decremented) {
        decremented = true
        this.activeLongPolls = Math.max(0, this.activeLongPolls - 1)
      }
      abortController.abort()
    }
    socket.on('close', onClose)

    // Why: for long-poll requests we start a keepalive ticker after 10 s. The
    // first frame at 10 s resets both the server's 30 s idle timer and the
    // client's configured timeout. Short RPCs never see a keepalive — the
    // ticker never fires because the handler resolves first.
    let keepaliveTimer: NodeJS.Timeout | null = null
    if (longPoll) {
      keepaliveTimer = setInterval(() => {
        if (socket.writable && !socket.destroyed) {
          socket.write('{"_keepalive":true}\n')
        }
      }, this.keepaliveIntervalMs)
      // Why: don't hold the process open solely on the keepalive interval —
      // .unref() lets the event loop exit when nothing else is pending.
      if (typeof keepaliveTimer.unref === 'function') {
        keepaliveTimer.unref()
      }
    }

    try {
      const response = await this.dispatcher.dispatch(request, {
        signal: longPoll ? abortController.signal : undefined
      })
      if (!socket.destroyed) {
        this.safeWrite(socket, `${JSON.stringify(response)}\n`)
      }
    } finally {
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer)
      }
      // Why: the close-handler path is still what decrements the counter (the
      // socket may be closed by the client before the response write flushes).
      // We don't remove the listener here — `once` semantics are handled by
      // the boolean guard.
    }
  }

  private parseAndAuth(rawMessage: string): { request: RpcRequest } | { error: RpcResponse } {
    let request: RpcRequest
    try {
      request = JSON.parse(rawMessage) as RpcRequest
    } catch {
      return { error: this.buildError('unknown', 'bad_request', 'Invalid JSON request') }
    }

    if (typeof request.id !== 'string' || request.id.length === 0) {
      return { error: this.buildError('unknown', 'bad_request', 'Missing request id') }
    }
    if (typeof request.method !== 'string' || request.method.length === 0) {
      return { error: this.buildError(request.id, 'bad_request', 'Missing RPC method') }
    }
    if (typeof request.authToken !== 'string' || request.authToken.length === 0) {
      return { error: this.buildError(request.id, 'unauthorized', 'Missing auth token') }
    }
    if (request.authToken !== this.authToken) {
      return { error: this.buildError(request.id, 'unauthorized', 'Invalid auth token') }
    }

    return { request }
  }

  private safeWrite(socket: Socket, payload: string): void {
    if (socket.destroyed || !socket.writable) {
      return
    }
    try {
      socket.write(payload)
    } catch {
      // Socket was closed in between the writable check and the write —
      // nothing we can do; the client already disconnected.
    }
  }

  private buildError(id: string, code: string, message: string): RpcResponse {
    return errorResponse(id, { runtimeId: this.runtime.getRuntimeId() }, code, message)
  }

  private writeMetadata(): void {
    const metadata: RuntimeMetadata = {
      runtimeId: this.runtime.getRuntimeId(),
      pid: this.pid,
      transport: this.transport,
      authToken: this.authToken,
      startedAt: this.runtime.getStartedAt()
    }
    writeRuntimeMetadata(this.userDataPath, metadata)
  }
}

/**
 * Why: the regex MUST stay in lockstep with createRuntimeTransportMetadata()
 * below, which emits `o-${pid}-${endpointSuffix}.sock` where endpointSuffix
 * is `[A-Za-z0-9_-]{1,4}` (derived from a sanitised runtimeId prefix, or
 * `'rt'` as the fallback). The invariant is covered by a unit test so any
 * future change to the transport-name shape trips CI.
 */
export const RUNTIME_SOCKET_NAME_REGEX = /^o-(\d+)-[A-Za-z0-9_-]+\.sock$/

export function sweepOrphanedRuntimeSockets(userDataPath: string, ownPid: number): void {
  let entries: string[]
  try {
    entries = readdirSync(userDataPath)
  } catch {
    // Why: first-launch userData may not exist yet; the cold-start path
    // below will create it. Nothing to sweep in that case.
    return
  }
  for (const entry of entries) {
    const match = RUNTIME_SOCKET_NAME_REGEX.exec(entry)
    if (!match) {
      continue
    }
    const pid = Number(match[1])
    if (!Number.isFinite(pid)) {
      continue
    }
    // Why: never touch the current process's socket. start() already
    // rmSync's it if it exists, but belt-and-braces — a bug in the own-pid
    // path here would rmSync a socket we're about to bind to.
    if (pid === ownPid) {
      continue
    }
    try {
      // Why: signal 0 is the POSIX liveness probe — it delivers no signal
      // but returns success iff the pid resolves AND the caller has
      // permission to signal it. ESRCH = no such process; EPERM = pid
      // exists but owned by another user, which is extremely unusual on a
      // desktop app's userData dir but we conservatively leave those
      // sockets alone.
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        try {
          rmSync(join(userDataPath, entry), { force: true })
        } catch {
          // Why: best-effort sweep — a permission error on unlink is fine
          // to ignore; the socket will be cleaned by a later start() or
          // by the OS on reboot.
        }
      }
    }
  }
}

export function createRuntimeTransportMetadata(
  userDataPath: string,
  pid: number,
  platform: NodeJS.Platform,
  runtimeId = 'runtime'
): RuntimeTransportMetadata {
  const endpointSuffix = runtimeId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 4) || 'rt'
  if (platform === 'win32') {
    return {
      kind: 'named-pipe',
      // Why: Windows named pipes do not get the same chmod hardening path as
      // Unix sockets, so include a per-runtime suffix to avoid exposing a
      // stable, guessable control endpoint name across launches.
      endpoint: `\\\\.\\pipe\\orca-${pid}-${endpointSuffix}`
    }
  }
  return {
    kind: 'unix',
    endpoint: join(userDataPath, `o-${pid}-${endpointSuffix}.sock`)
  }
}
