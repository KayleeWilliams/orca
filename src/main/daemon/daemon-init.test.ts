import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'net'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getDaemonSocketPath } from './daemon-spawner'
import { PREVIOUS_DAEMON_PROTOCOL_VERSIONS } from './types'

type ClientPlan = {
  ensureReject?: boolean
  requestReject?: boolean
  sessions?: { sessionId: string; isAlive: boolean }[]
  delayMs?: number
}

const mocks = vi.hoisted(() => ({
  killStaleDaemon: vi.fn(async () => true),
  setLocalPtyProvider: vi.fn(),
  clientPlans: [] as ClientPlan[],
  clientInstances: [] as MockDaemonClient[]
}))

class MockDaemonClient {
  plan: ClientPlan
  ensureConnected = vi.fn(async () => {
    if (this.plan.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.plan.delayMs))
    }
    if (this.plan.ensureReject) {
      throw new Error('connect failed')
    }
  })
  request = vi.fn(async (method: string) => {
    if (this.plan.requestReject) {
      throw new Error('request failed')
    }
    if (method === 'listSessions') {
      return { sessions: this.plan.sessions ?? [] }
    }
    return {}
  })
  disconnect = vi.fn()

  constructor() {
    this.plan = mocks.clientPlans.shift() ?? {}
    mocks.clientInstances.push(this)
  }
}

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => mkdtempSync(join(tmpdir(), 'daemon-init-app-test-'))),
    getAppPath: vi.fn(() => '/app'),
    isPackaged: false
  }
}))

vi.mock('../ipc/pty', () => ({
  setLocalPtyProvider: mocks.setLocalPtyProvider
}))

vi.mock('./client', () => ({
  DaemonClient: MockDaemonClient
}))

vi.mock('./daemon-health', () => ({
  getProcessStartedAtMs: vi.fn(() => 1),
  healthCheckDaemon: vi.fn(async () => false),
  killStaleDaemon: mocks.killStaleDaemon
}))

function listen(socketPath: string): Promise<Server> {
  const server = createServer((socket) => socket.end())
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

describe('daemon init legacy cleanup', () => {
  let dir: string
  let servers: Server[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-init-test-'))
    servers = []
    mocks.clientPlans.length = 0
    mocks.clientInstances.length = 0
    mocks.killStaleDaemon.mockClear()
    mocks.setLocalPtyProvider.mockClear()
  })

  afterEach(async () => {
    await Promise.all(servers.map((server) => closeServer(server).catch(() => {})))
    rmSync(dir, { recursive: true, force: true })
    delete process.env.ORCA_DISABLE_LEGACY_CLEANUP
  })

  async function openLegacySocket(protocolVersion: number): Promise<void> {
    servers.push(await listen(getDaemonSocketPath(dir, protocolVersion)))
  }

  it('cleans up an idle legacy daemon and returns no adapter', async () => {
    const { processLegacyVersion } = await import('./daemon-init')
    await openLegacySocket(1)
    mocks.clientPlans.push({ sessions: [] }, { sessions: [] })

    await expect(processLegacyVersion(dir, 1)).resolves.toBeNull()

    expect(mocks.clientInstances).toHaveLength(2)
    expect(mocks.clientInstances[1].request).toHaveBeenCalledWith('shutdown', {
      killSessions: true
    })
  })

  it('wraps a live legacy daemon without calling cleanup', async () => {
    const { processLegacyVersion } = await import('./daemon-init')
    await openLegacySocket(1)
    mocks.clientPlans.push({ sessions: [{ sessionId: 'legacy-1', isAlive: true }] })

    const adapter = await processLegacyVersion(dir, 1)

    expect(adapter).not.toBeNull()
    expect(adapter?.protocolVersion).toBe(1)
    expect(mocks.clientInstances[0].request).toHaveBeenCalledWith('listSessions', undefined)
    expect(
      mocks.clientInstances.some((client) => client.request.mock.calls[0]?.[0] === 'shutdown')
    ).toBe(false)
  })

  it('falls back to stale pid cleanup for a wedged legacy daemon', async () => {
    const { processLegacyVersion } = await import('./daemon-init')
    await openLegacySocket(1)
    mocks.clientPlans.push({ ensureReject: true }, { ensureReject: true })

    await expect(processLegacyVersion(dir, 1)).resolves.toBeNull()

    expect(mocks.killStaleDaemon).toHaveBeenCalledWith(
      dir,
      getDaemonSocketPath(dir, 1),
      expect.any(String),
      1
    )
    expect(mocks.clientInstances[0].disconnect).toHaveBeenCalled()
  })

  it('does not open a client when the legacy socket is missing', async () => {
    const { processLegacyVersion } = await import('./daemon-init')

    await expect(processLegacyVersion(dir, 1)).resolves.toBeNull()

    expect(mocks.clientInstances).toHaveLength(0)
    expect(mocks.killStaleDaemon).not.toHaveBeenCalled()
  })

  it('aggregates mixed legacy cleanup outcomes', async () => {
    const { createLegacyDaemonAdapters } = await import('./daemon-init')
    await openLegacySocket(1)
    await openLegacySocket(2)
    mocks.clientPlans.push(
      { sessions: [] },
      { sessions: [{ sessionId: 'legacy-2', isAlive: true }] },
      { sessions: [] }
    )

    const adapters = await createLegacyDaemonAdapters(dir)

    expect(adapters).toHaveLength(1)
    expect(adapters[0].protocolVersion).toBe(2)
  })

  it('runs per-version probes in parallel', async () => {
    const { createLegacyDaemonAdapters } = await import('./daemon-init')
    for (const version of PREVIOUS_DAEMON_PROTOCOL_VERSIONS) {
      await openLegacySocket(version)
      mocks.clientPlans.push({
        sessions: [{ sessionId: `legacy-${version}`, isAlive: true }],
        delayMs: 80
      })
    }

    const start = Date.now()
    const adapters = await createLegacyDaemonAdapters(dir)

    expect(adapters).toHaveLength(PREVIOUS_DAEMON_PROTOCOL_VERSIONS.length)
    expect(Date.now() - start).toBeLessThan(180)
  })

  it('honors the legacy cleanup killswitch', async () => {
    const { getLegacyAdaptersForStartup } = await import('./daemon-init')
    process.env.ORCA_DISABLE_LEGACY_CLEANUP = '1'
    await openLegacySocket(1)
    mocks.clientPlans.push({ sessions: [{ sessionId: 'legacy-1', isAlive: true }] })

    await expect(getLegacyAdaptersForStartup(dir)).resolves.toEqual([])

    expect(mocks.clientInstances).toHaveLength(0)
  })
})
