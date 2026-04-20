/* eslint-disable max-lines */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { execFileMock, webContentsFromIdMock, existsSyncMock, readFileSyncMock } = vi.hoisted(
  () => ({
    execFileMock: vi.fn(),
    webContentsFromIdMock: vi.fn(),
    existsSyncMock: vi.fn(() => false),
    readFileSyncMock: vi.fn(() => Buffer.from(''))
  })
)

vi.mock('child_process', () => ({ execFile: execFileMock }))
vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  accessSync: vi.fn(),
  chmodSync: vi.fn(),
  constants: { X_OK: 1 }
}))
vi.mock('os', () => ({ platform: () => 'darwin', arch: () => 'arm64' }))
vi.mock('electron', () => {
  return {
    app: { getPath: vi.fn(() => '/app'), getAppPath: vi.fn(() => '/project'), isPackaged: false },
    webContents: { fromId: webContentsFromIdMock }
  }
})
const { CdpWsProxyMock } = vi.hoisted(() => {
  const instances: unknown[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const MockClass = vi.fn().mockImplementation(function (this: any, _wc: unknown) {
    this.start = vi.fn(async () => 'ws://127.0.0.1:9222')
    this.stop = vi.fn(async () => {})
    this.getPort = vi.fn(() => 9222)
    instances.push(this)
  })
  return { CdpWsProxyMock: Object.assign(MockClass, { instances }) }
})

vi.mock('./cdp-ws-proxy', () => ({
  CdpWsProxy: CdpWsProxyMock
}))
vi.mock('./cdp-bridge', () => ({
  BrowserError: class BrowserError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }
}))

import { AgentBrowserBridge } from './agent-browser-bridge'
import type { BrowserManager } from './browser-manager'

// Why: the bridge resolves webContents via dynamic require('electron').webContents.fromId
// inside a try/catch. Override the private method to inject our mock.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(AgentBrowserBridge.prototype as any).getWebContents = function (id: number) {
  return webContentsFromIdMock(id) ?? null
}

function mockBrowserManager(
  tabs: Map<string, number> = new Map([['tab-1', 100]]),
  worktrees: Map<string, string> = new Map(),
  overrides: Partial<BrowserManager> = {}
): BrowserManager {
  return {
    getWebContentsIdByTabId: () => tabs,
    getWorktreeIdForTab: (tabId: string) => worktrees.get(tabId),
    getGuestWebContentsId: vi.fn(() => null),
    ensureWebviewVisible: vi.fn(async () => () => {}),
    ...overrides
  } as unknown as BrowserManager
}

function mockWebContents(id: number, url = 'https://example.com', title = 'Example') {
  return {
    id,
    getURL: () => url,
    getTitle: () => title,
    isDestroyed: () => false,
    debugger: {
      attach: vi.fn(),
      detach: vi.fn(),
      sendCommand: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn()
    }
  }
}

function succeedWith(data: unknown): void {
  execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, JSON.stringify({ success: true, data }), '')
  })
}

function failWith(error: string): void {
  execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, JSON.stringify({ success: false, error }), '')
  })
}

describe('AgentBrowserBridge', () => {
  let bridge: AgentBrowserBridge

  beforeEach(() => {
    vi.clearAllMocks()
    CdpWsProxyMock.instances.length = 0
    existsSyncMock.mockReturnValue(false)
    readFileSyncMock.mockReturnValue(Buffer.from(''))
    const wc = mockWebContents(100)
    webContentsFromIdMock.mockReturnValue(wc)
    bridge = new AgentBrowserBridge(mockBrowserManager())
    bridge.setActiveTab(100)
  })

  // ── Session naming ──

  it('uses browserPageId as session name', async () => {
    succeedWith({ snapshot: '...' })
    await bridge.snapshot()

    const args = execFileMock.mock.calls[0][1] as string[]
    expect(args).toContain('--session')
    expect(args[args.indexOf('--session') + 1]).toBe('orca-tab-tab-1')
  })

  // ── --cdp first-use only ──

  it('passes --cdp only on first command for a session', async () => {
    succeedWith({ snapshot: '...' })
    await bridge.snapshot()

    // Why: calls[0] is stale-session 'close'; find the snapshot call
    const snapshotCall = execFileMock.mock.calls.find((c: unknown[]) =>
      (c[1] as string[]).includes('snapshot')
    )
    expect(snapshotCall![1]).toContain('--cdp')
    const cdpIdx = (snapshotCall![1] as string[]).indexOf('--cdp')
    expect((snapshotCall![1] as string[])[cdpIdx + 1]).toBe('9222')

    succeedWith({ clicked: '@e1' })
    await bridge.click('@e1')

    const clickCall = execFileMock.mock.calls.find((c: unknown[]) =>
      (c[1] as string[]).includes('click')
    )
    expect(clickCall![1]).not.toContain('--cdp')
  })

  // ── --json always appended ──

  it('always appends --json to commands', async () => {
    succeedWith({ snapshot: '...' })
    await bridge.snapshot()

    const snapshotCall = execFileMock.mock.calls.find((c: unknown[]) =>
      (c[1] as string[]).includes('snapshot')
    )
    expect((snapshotCall![1] as string[]).at(-1)).toBe('--json')
  })

  // ── Output translation ──

  it('translates success response to result', async () => {
    succeedWith({ snapshot: 'tree output' })
    const result = await bridge.snapshot()
    expect(result).toEqual({ snapshot: 'tree output' })
  })

  it('translates error response to BrowserError', async () => {
    failWith('Element not found')
    await expect(bridge.click('@e1')).rejects.toThrow('Element not found')
  })

  it('handles malformed JSON from agent-browser', async () => {
    execFileMock.mockImplementation(
      (_bin: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, 'not json at all', '')
      }
    )
    await expect(bridge.snapshot()).rejects.toThrow()
  })

  // ── exec passthrough ──

  it('strips --cdp and --session from exec commands', async () => {
    succeedWith({ output: 'ok' })
    await bridge.exec('dblclick @e3 --cdp ws://evil --session hijack')

    // Why: find the actual exec call (contains 'dblclick'), not the stale-session close
    const execCall = execFileMock.mock.calls.find((c: unknown[]) =>
      (c[1] as string[]).includes('dblclick')
    )
    const args = execCall![1] as string[]
    // The bridge's own --session and --cdp (for session init) are expected.
    // Verify the user-injected ones were stripped: no 'ws://evil' or 'hijack'
    expect(args.join(' ')).not.toContain('ws://evil')
    expect(args.join(' ')).not.toContain('hijack')
    expect(args).toContain('dblclick')
    expect(args).toContain('@e3')
  })

  // ── Worktree filtering ──

  describe('worktree filtering', () => {
    it('returns all tabs when no worktreeId', () => {
      const tabs = new Map([
        ['tab-a', 1],
        ['tab-b', 2]
      ])
      const b = new AgentBrowserBridge(mockBrowserManager(tabs))
      const result = b.tabList()
      expect(result.tabs).toHaveLength(2)
    })

    it('returns only matching worktree tabs', () => {
      const tabs = new Map([
        ['tab-a', 1],
        ['tab-b', 2]
      ])
      const worktrees = new Map([
        ['tab-a', 'wt-1'],
        ['tab-b', 'wt-2']
      ])
      const wc1 = mockWebContents(1, 'https://a.com', 'A')
      const wc2 = mockWebContents(2, 'https://b.com', 'B')
      webContentsFromIdMock.mockImplementation((id: number) => (id === 1 ? wc1 : wc2))

      const b = new AgentBrowserBridge(mockBrowserManager(tabs, worktrees))
      const result = b.tabList('wt-1')
      expect(result.tabs).toHaveLength(1)
      expect(result.tabs[0].url).toBe('https://a.com')
    })
  })

  // ── Tab switch ──

  it('throws on out-of-range tab index', async () => {
    await expect(bridge.tabSwitch(99)).rejects.toThrow('Tab index 99 out of range')
  })

  // ── No tab error ──

  it('throws browser_no_tab when no tabs registered', async () => {
    const b = new AgentBrowserBridge(mockBrowserManager(new Map()))
    await expect(b.snapshot()).rejects.toThrow('No browser tab open')
  })

  // ── Command queue serialization ──

  it('serializes concurrent commands per session', async () => {
    const commandCalls: string[][] = []

    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: Function) => {
        commandCalls.push(args)
        cb(null, JSON.stringify({ success: true, data: { ok: true } }), '')
      }
    )

    const [r1, r2] = await Promise.all([bridge.snapshot(), bridge.click('@e1')])
    expect(r1).toEqual({ ok: true })
    expect(r2).toEqual({ ok: true })
    // Why: close runs first (stale session cleanup), then commands execute sequentially
    const snapshotIdx = commandCalls.findIndex((a) => a.includes('snapshot'))
    const clickIdx = commandCalls.findIndex((a) => a.includes('click'))
    expect(snapshotIdx).toBeLessThan(clickIdx)
  })

  it('serializes screenshot visibility prep across sessions', async () => {
    vi.useFakeTimers()
    try {
      const tabs = new Map([
        ['tab-1', 1],
        ['tab-2', 2]
      ])
      const worktrees = new Map([
        ['tab-1', 'wt-1'],
        ['tab-2', 'wt-2']
      ])
      const lifecycleEvents: string[] = []
      const ensureWebviewVisibleMock = vi.fn(async (webContentsId: number) => {
        lifecycleEvents.push(`ensure-${webContentsId}`)
        return () => {
          lifecycleEvents.push(`restore-${webContentsId}`)
        }
      })
      const wc1 = mockWebContents(1)
      const wc2 = mockWebContents(2)
      webContentsFromIdMock.mockImplementation((id: number) =>
        id === 1 ? wc1 : id === 2 ? wc2 : null
      )
      existsSyncMock.mockReturnValue(true)
      const screenshotBytes = Buffer.from('serialized-screenshot')
      readFileSyncMock.mockReturnValue(screenshotBytes)

      const b = new AgentBrowserBridge(
        mockBrowserManager(tabs, worktrees, {
          ensureWebviewVisible: ensureWebviewVisibleMock
        })
      )
      b.setActiveTab(1, 'wt-1')
      b.setActiveTab(2, 'wt-2')

      let releaseFirstScreenshot: (() => void) | null = null
      execFileMock.mockImplementation(
        (_bin: string, args: string[], _opts: unknown, cb: Function) => {
          if (args.includes('close')) {
            cb(null, JSON.stringify({ success: true, data: null }), '')
            return
          }
          if (args.includes('screenshot')) {
            const sessionName = args[args.indexOf('--session') + 1]
            lifecycleEvents.push(`command-${sessionName}`)
            if (sessionName === 'orca-tab-tab-1' && !releaseFirstScreenshot) {
              releaseFirstScreenshot = () => {
                cb(null, JSON.stringify({ success: true, data: { path: '/tmp/tab-1.png' } }), '')
              }
              return
            }
            cb(
              null,
              JSON.stringify({ success: true, data: { path: `/tmp/${sessionName}.png` } }),
              ''
            )
            return
          }
          cb(null, JSON.stringify({ success: true, data: { ok: true } }), '')
        }
      )

      const first = b.screenshot('png', 'wt-1')
      const second = b.screenshot('png', 'wt-2')

      await Promise.resolve()
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(300)

      expect(lifecycleEvents).toContain('ensure-1')
      expect(lifecycleEvents).toContain('command-orca-tab-tab-1')
      expect(lifecycleEvents).not.toContain('ensure-2')

      expect(releaseFirstScreenshot).not.toBeNull()
      releaseFirstScreenshot!()
      await expect(first).resolves.toEqual({
        data: screenshotBytes.toString('base64'),
        format: 'png'
      })

      await Promise.resolve()
      await Promise.resolve()

      expect(lifecycleEvents.indexOf('restore-1')).toBeLessThan(lifecycleEvents.indexOf('ensure-2'))

      await vi.advanceTimersByTimeAsync(300)
      await expect(second).resolves.toEqual({
        data: screenshotBytes.toString('base64'),
        format: 'png'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  // ── Timeout escalation ──

  it('destroys session after 3 consecutive timeouts', async () => {
    const killedError = Object.assign(new Error('timeout'), { killed: true })

    execFileMock.mockImplementation(
      (_bin: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(killedError, '', '')
      }
    )

    for (let i = 0; i < 3; i++) {
      await expect(bridge.snapshot()).rejects.toThrow('timed out')
    }

    // Session is destroyed — next command should re-create it (new --cdp flag)
    succeedWith({ snapshot: 'fresh' })
    await bridge.snapshot()

    const lastArgs = execFileMock.mock.calls.at(-1)![1] as string[]
    expect(lastArgs).toContain('--cdp')
  })

  it('waits for pending session destruction before recreating the same session', async () => {
    succeedWith({ snapshot: 'initial' })
    await bridge.snapshot()

    execFileMock.mockClear()

    const commandCalls: string[][] = []
    let releaseDestroyClose: (() => void) | null = null
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: Function) => {
        commandCalls.push(args)
        if (args.includes('close')) {
          if (!releaseDestroyClose) {
            releaseDestroyClose = () => {
              cb(null, JSON.stringify({ success: true, data: null }), '')
            }
            return
          }
          cb(null, JSON.stringify({ success: true, data: null }), '')
          return
        }
        if (args.includes('snapshot')) {
          cb(null, JSON.stringify({ success: true, data: { snapshot: 'after-destroy' } }), '')
          return
        }
        cb(null, JSON.stringify({ success: true, data: { ok: true } }), '')
      }
    )

    const destroyPromise = (
      bridge as unknown as { destroySession: (name: string) => Promise<void> }
    ).destroySession('orca-tab-tab-1')
    const nextSnapshot = bridge.snapshot()

    await Promise.resolve()
    await Promise.resolve()

    expect(commandCalls.filter((args) => args.includes('close'))).toHaveLength(1)
    expect(commandCalls.some((args) => args.includes('snapshot'))).toBe(false)
    expect(releaseDestroyClose).not.toBeNull()

    releaseDestroyClose!()
    await destroyPromise
    await expect(nextSnapshot).resolves.toEqual({ snapshot: 'after-destroy' })
    expect(commandCalls.filter((args) => args.includes('close'))).toHaveLength(2)
  })

  // ── Process swap ──

  it('destroys session on process swap and re-inits with --cdp', async () => {
    const tabs = new Map([['tab-1', 100]])
    const mgr = mockBrowserManager(tabs)
    const b = new AgentBrowserBridge(mgr)
    b.setActiveTab(100)

    succeedWith({ snapshot: 'tree' })
    await b.snapshot()

    // Why: calls[0] is the stale-session 'close'; find the snapshot call with --cdp
    const firstSnapshotCall = execFileMock.mock.calls.find((c: unknown[]) =>
      (c[1] as string[]).includes('snapshot')
    )
    expect(firstSnapshotCall![1]).toContain('--cdp')

    // Simulate process swap: update tab mapping + notify bridge
    tabs.set('tab-1', 200)
    const newWc = mockWebContents(200)
    webContentsFromIdMock.mockReturnValue(newWc)
    succeedWith(null) // for the 'close' command in destroySession
    await b.onProcessSwap('tab-1', 200)

    // Next command should re-init with --cdp since session was destroyed
    succeedWith({ snapshot: 'new tree' })
    await b.snapshot()

    const snapshotCalls = execFileMock.mock.calls.filter((c: unknown[]) =>
      (c[1] as string[]).includes('snapshot')
    )
    expect(snapshotCalls.length).toBeGreaterThanOrEqual(2)
    const lastSnapshotArgs = snapshotCalls.at(-1)![1] as string[]
    // After process swap + session destroy, the new session must re-init with --cdp
    expect(lastSnapshotArgs).toContain('--cdp')
  })

  // ── Tab close clears active ──

  it('clears activeWebContentsId on tab close', async () => {
    succeedWith({ snapshot: 'tree' })
    await bridge.snapshot()

    await bridge.onTabClosed(100)
    expect(bridge.getActiveWebContentsId()).toBeNull()
  })

  // ── tabSwitch success ──

  it('switches active tab and returns switched index', async () => {
    const tabs = new Map([
      ['tab-a', 1],
      ['tab-b', 2]
    ])
    const wc1 = mockWebContents(1)
    const wc2 = mockWebContents(2)
    webContentsFromIdMock.mockImplementation((id: number) => (id === 1 ? wc1 : wc2))

    const b = new AgentBrowserBridge(mockBrowserManager(tabs))
    b.setActiveTab(1)

    const result = await b.tabSwitch(1)
    expect(result).toEqual({ switched: 1 })
    expect(b.getActiveWebContentsId()).toBe(2)
  })

  it('queues tabSwitch behind in-flight commands on the current session', async () => {
    const tabs = new Map([
      ['tab-a', 1],
      ['tab-b', 2]
    ])
    const worktrees = new Map([
      ['tab-a', 'wt-1'],
      ['tab-b', 'wt-1']
    ])
    const wc1 = mockWebContents(1)
    const wc2 = mockWebContents(2)
    webContentsFromIdMock.mockImplementation((id: number) =>
      id === 1 ? wc1 : id === 2 ? wc2 : null
    )

    const b = new AgentBrowserBridge(mockBrowserManager(tabs, worktrees))
    b.setActiveTab(1, 'wt-1')

    let releaseSnapshot: (() => void) | null = null
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: Function) => {
        if (args.includes('close')) {
          cb(null, JSON.stringify({ success: true, data: null }), '')
          return
        }
        if (args.includes('snapshot')) {
          releaseSnapshot = () => {
            cb(null, JSON.stringify({ success: true, data: { snapshot: 'tree' } }), '')
          }
          return
        }
        cb(null, JSON.stringify({ success: true, data: { ok: true } }), '')
      }
    )

    const snapshot = b.snapshot('wt-1')
    const switched = b.tabSwitch(1, 'wt-1')

    await Promise.resolve()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(b.getActiveWebContentsId()).toBe(1)
    expect(releaseSnapshot).not.toBeNull()

    releaseSnapshot!()
    await expect(snapshot).resolves.toEqual({ snapshot: 'tree' })
    await expect(switched).resolves.toEqual({ switched: 1 })
    expect(b.getActiveWebContentsId()).toBe(2)
  })

  // ── goto command ──

  it('passes url to goto command', async () => {
    succeedWith({ url: 'https://example.com', title: 'Example' })
    await bridge.goto('https://example.com')

    const args = execFileMock.mock.calls.at(-1)![1] as string[]
    expect(args).toContain('goto')
    expect(args).toContain('https://example.com')
  })

  // ── Cookie command arg building ──

  it('builds cookie set args with all options', async () => {
    succeedWith({ success: true })
    await bridge.cookieSet({
      name: 'sid',
      value: 'abc',
      domain: '.example.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
      expires: 1700000000
    })

    const args = execFileMock.mock.calls.at(-1)![1] as string[]
    expect(args).toContain('cookies')
    expect(args).toContain('set')
    expect(args).toContain('sid')
    expect(args).toContain('abc')
    expect(args).toContain('--domain')
    expect(args).toContain('.example.com')
    expect(args).toContain('--path')
    expect(args).toContain('/')
    expect(args).toContain('--secure')
    expect(args).toContain('--httpOnly')
    expect(args).toContain('--sameSite')
    expect(args).toContain('Lax')
    expect(args).toContain('--expires')
    expect(args).toContain('1700000000')
  })

  // ── Viewport command arg building ──

  it('builds viewport args with scale', async () => {
    succeedWith({ width: 375, height: 812, mobile: true })
    await bridge.setViewport(375, 812, 2, true)

    // Why: calls[0] is the stale-session 'close'; the actual command is the last call
    const args = execFileMock.mock.calls.at(-1)![1] as string[]
    expect(args).toContain('set')
    expect(args).toContain('viewport')
    expect(args).toContain('375')
    expect(args).toContain('812')
    expect(args).toContain('2')
  })

  // ── Stderr passthrough on non-timeout errors ──

  it('passes stderr through as error message on execFile failure', async () => {
    execFileMock.mockImplementation(
      (_bin: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(new Error('exit code 1'), '', 'daemon crashed: segfault')
      }
    )
    await expect(bridge.snapshot()).rejects.toThrow('daemon crashed: segfault')
  })

  it('falls back to error.message when stderr is empty', async () => {
    execFileMock.mockImplementation(
      (_bin: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(new Error('Command failed'), '', '')
      }
    )
    await expect(bridge.snapshot()).rejects.toThrow('Command failed')
  })

  // ── Malformed JSON returns BrowserError ──

  it('returns browser_error with truncated output for malformed JSON', async () => {
    execFileMock.mockImplementation(
      (_bin: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, 'Error: not json output', '')
      }
    )
    await expect(bridge.snapshot()).rejects.toThrow('Unexpected output from agent-browser')
  })

  // ── destroyAllSessions ──

  it('destroys all active sessions', async () => {
    succeedWith({ snapshot: 'tree' })
    await bridge.snapshot()

    // Should have one session now
    succeedWith(null) // for the 'close' call
    await bridge.destroyAllSessions()

    // Next command should re-create session with --cdp
    succeedWith({ snapshot: 'fresh' })
    await bridge.snapshot()

    const snapshotCalls = execFileMock.mock.calls.filter((c: unknown[]) =>
      (c[1] as string[]).includes('snapshot')
    )
    const lastSnapshotArgs = snapshotCalls.at(-1)![1] as string[]
    expect(lastSnapshotArgs).toContain('--cdp')
  })
})
