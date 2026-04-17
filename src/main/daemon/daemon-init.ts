import { join } from 'path'
import { app } from 'electron'
import { mkdirSync, existsSync, unlinkSync, readFileSync, writeFileSync } from 'fs'
import { fork, execFileSync } from 'child_process'
import { connect, type Socket } from 'net'
import { DaemonSpawner, getDaemonPidPath, type DaemonLauncher } from './daemon-spawner'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { setLocalPtyProvider } from '../ipc/pty'
import { PROTOCOL_VERSION } from './types'
import { encodeNdjson } from './ndjson'
import type { HelloMessage, HelloResponse } from './types'

let spawner: DaemonSpawner | null = null
let adapter: DaemonPtyAdapter | null = null

function getRuntimeDir(): string {
  const dir = join(app.getPath('userData'), 'daemon')
  mkdirSync(dir, { recursive: true })
  return dir
}

function getHistoryDir(): string {
  const dir = join(app.getPath('userData'), 'terminal-history')
  mkdirSync(dir, { recursive: true })
  return dir
}

function getDaemonEntryPath(): string {
  const appPath = app.getAppPath()
  // Why: electron-builder unpacks daemon-entry.js so child_process.fork() can
  // execute it from disk. In packaged apps app.getAppPath() points at
  // app.asar, so redirect to the unpacked sibling before joining the script.
  const basePath = app.isPackaged ? appPath.replace('app.asar', 'app.asar.unpacked') : appPath
  return join(basePath, 'out', 'main', 'daemon-entry.js')
}

const HEALTH_CHECK_TIMEOUT_MS = 3000

// Why: a raw TCP connect (the old probeSocket) only proves the socket is
// listening — it cannot detect a daemon that accepted connections but is
// otherwise broken (hung, corrupt state, stale binary). A full protocol-level
// health check (connect → hello → ping RPC) confirms the daemon can actually
// process requests. If it fails, the caller kills and respawns rather than
// handing a broken daemon to the rest of the app.
function healthCheckDaemon(socketPath: string, tokenPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' && !existsSync(socketPath)) {
      resolve(false)
      return
    }

    let token: string
    try {
      token = readFileSync(tokenPath, 'utf-8').trim()
    } catch {
      resolve(false)
      return
    }

    let settled = false
    const settle = (result: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      sock.destroy()
      resolve(result)
    }

    const timer = setTimeout(() => settle(false), HEALTH_CHECK_TIMEOUT_MS)

    const sock: Socket = connect({ path: socketPath })
    sock.on('error', () => settle(false))

    sock.on('connect', () => {
      const hello: HelloMessage = {
        type: 'hello',
        version: PROTOCOL_VERSION,
        token,
        clientId: 'health-check',
        role: 'control'
      }
      sock.write(encodeNdjson(hello))

      let buffer = ''
      sock.on('data', (chunk: Buffer) => {
        if (settled) {
          return
        }
        buffer += chunk.toString()
        let newlineIdx: number
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIdx)
          buffer = buffer.slice(newlineIdx + 1)
          if (line.length === 0) {
            continue
          }

          let msg: Record<string, unknown>
          try {
            msg = JSON.parse(line) as Record<string, unknown>
          } catch {
            settle(false)
            return
          }

          if (msg.type === 'hello') {
            if (!(msg as HelloResponse).ok) {
              settle(false)
              return
            }
            sock.write(encodeNdjson({ id: 'health-1', type: 'ping' }))
            continue
          }

          if (msg.id === 'health-1') {
            // Why: treat any coherent RPC response as healthy, even
            // { ok: false } from an older daemon that doesn't know "ping".
            // The daemon parsed, routed, and replied — it's alive.
            settle(true)
            return
          }
        }
      })
    })
  })
}

// Why: validates that a PID from the PID file is actually a daemon-entry
// process before killing it. Without this check, a stale PID file left
// after a daemon crash could cause us to SIGTERM an unrelated process
// that reused the PID.
function isDaemonProcess(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }

  if (process.platform === 'win32') {
    // Why: Windows named pipe ownership already gates whether the new
    // daemon can bind. If the old process isn't our daemon, the pipe
    // name won't conflict and no kill is needed. If it IS our daemon,
    // the pipe name matches and we need to kill it. WMIC/tasklist
    // checks are fragile and slow — accept the small risk.
    return true
  }

  try {
    // Why: /proc exists on Linux but not macOS. Check command line
    // to confirm this PID is actually running daemon-entry.
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8')
    return cmdline.includes('daemon-entry')
  } catch {
    // macOS: use ps to check the process command
    try {
      const output = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf-8',
        timeout: 2000
      })
      return output.includes('daemon-entry')
    } catch {
      return false
    }
  }
}

const KILL_WAIT_MS = 3000
const KILL_POLL_MS = 100

// Why: kills the stale daemon process (via PID file) and removes the socket
// so a new daemon can bind. We do NOT send a shutdown RPC because
// DaemonServer.shutdown() unconditionally kills all PTY sessions — that
// would destroy warm-reattach terminals. SIGTERM lets the daemon's own
// signal handler run its cleanup. We wait for the process to exit so the
// named pipe (Windows) or socket is released before the new daemon binds.
async function killStaleDaemon(runtimeDir: string, socketPath: string): Promise<void> {
  const pidPath = getDaemonPidPath(runtimeDir)
  try {
    const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10)
    if (!isNaN(pid) && isDaemonProcess(pid)) {
      process.kill(pid, 'SIGTERM')

      // Why: wait for the process to actually exit so the socket/pipe is
      // released. Without this, the new daemon's listen() can fail with
      // EADDRINUSE on Windows where named pipes can't be unlinked.
      const deadline = Date.now() + KILL_WAIT_MS
      let exited = false
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0)
        } catch {
          exited = true
          break
        }
        await new Promise((r) => setTimeout(r, KILL_POLL_MS))
      }

      // Why: if the daemon's event loop is wedged, SIGTERM never runs the
      // JS handler. Escalate to SIGKILL to guarantee the process dies and
      // releases the socket/pipe.
      if (!exited) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Already dead
        }
      }
    }
  } catch {
    // PID file missing or process already dead
  }

  try {
    unlinkSync(pidPath)
  } catch {
    // Best-effort
  }

  if (process.platform !== 'win32' && existsSync(socketPath)) {
    try {
      unlinkSync(socketPath)
    } catch {
      // Best-effort
    }
  }
}

function createOutOfProcessLauncher(runtimeDir: string): DaemonLauncher {
  return async (socketPath, tokenPath) => {
    const healthy = await healthCheckDaemon(socketPath, tokenPath)
    if (healthy) {
      // Why: daemon is already running from a previous app session and
      // responded to a full protocol-level ping. Safe to reuse.
      return { shutdown: async () => {} }
    }

    // Why: health check failed — either no daemon, crashed daemon with
    // stale socket, or alive-but-broken daemon. Kill the old process
    // (via PID file) and remove the socket so a new daemon can bind.
    await killStaleDaemon(runtimeDir, socketPath)

    const entryPath = getDaemonEntryPath()
    const child = fork(entryPath, ['--socket', socketPath, '--token', tokenPath], {
      // Why: detached + unref lets the daemon outlive the Electron process.
      // stdio 'ignore' prevents the child from holding the parent's stdout
      // open, which would prevent Electron from exiting cleanly.
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      // Why: ELECTRON_RUN_AS_NODE makes the forked process run as a plain
      // Node.js process instead of an Electron renderer/main process. Without
      // it, Electron's GPU/display initialization can interfere with native
      // module operations like node-pty's posix_spawn of the spawn-helper.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })

    // Wait for the daemon to signal readiness via IPC
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error): void => {
        clearTimeout(timer)
        if (child.pid) {
          try {
            process.kill(child.pid, 'SIGTERM')
          } catch {
            // Already dead
          }
        }
        reject(error)
      }
      const timer = setTimeout(() => {
        fail(new Error('Daemon startup timed out'))
      }, 10000)

      child.on('message', (msg: unknown) => {
        if (msg && typeof msg === 'object' && (msg as { type?: string }).type === 'ready') {
          clearTimeout(timer)

          if (child.pid) {
            writeFileSync(getDaemonPidPath(runtimeDir), String(child.pid), { mode: 0o600 })
          }

          // Why: disconnect IPC channel and unref so Electron can exit
          // without waiting for the daemon. The daemon keeps running.
          child.disconnect()
          child.unref()
          resolve()
        }
      })

      child.on('error', (err) => {
        fail(err)
      })

      child.on('exit', (code) => {
        fail(new Error(`Daemon exited during startup with code ${code}`))
      })
    })

    return {
      shutdown: async () => {
        if (child.pid) {
          try {
            process.kill(child.pid, 'SIGTERM')
          } catch {
            // Already dead
          }
        }
      }
    }
  }
}

export async function initDaemonPtyProvider(): Promise<void> {
  const runtimeDir = getRuntimeDir()

  const newSpawner = new DaemonSpawner({
    runtimeDir,
    launcher: createOutOfProcessLauncher(runtimeDir)
  })

  // Why: assign spawner/adapter only after both succeed. If ensureRunning()
  // throws, a stale spawner would prevent shutdownDaemon() from cleaning up
  // correctly on retry.
  const info = await newSpawner.ensureRunning()

  const newAdapter = new DaemonPtyAdapter({
    socketPath: info.socketPath,
    tokenPath: info.tokenPath,
    historyPath: getHistoryDir()
  })

  spawner = newSpawner
  adapter = newAdapter
  setLocalPtyProvider(adapter)
}

// Why: disconnect from the daemon without killing it. The daemon runs as a
// separate process and survives app quit — sessions stay alive for warm
// reattach on next launch. Leave history sessions marked "unclean" here so a
// later daemon crash while Orca is closed is still recoverable on next launch.
export function disconnectDaemon(): void {
  adapter?.disconnectOnly()
  adapter = null
}

/** Kill the daemon and all its sessions. Use for full cleanup only. */
export async function shutdownDaemon(): Promise<void> {
  adapter?.dispose()
  adapter = null
  await spawner?.shutdown()
  spawner = null

  try {
    unlinkSync(getDaemonPidPath(getRuntimeDir()))
  } catch {
    // Best-effort — PID file may not exist
  }
}
