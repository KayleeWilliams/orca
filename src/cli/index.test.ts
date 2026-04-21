/* oxlint-disable max-lines -- Why: CLI parsing behavior is exercised end-to-end
in one file so command and flag interactions stay visible in a single suite. */
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('./runtime-client', () => {
  class RuntimeClient {
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()
  }

  class RuntimeClientError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }

  class RuntimeRpcFailureError extends RuntimeClientError {
    readonly response: unknown

    constructor(response: unknown) {
      super('runtime_error', 'runtime_error')
      this.response = response
    }
  }

  return {
    RuntimeClient,
    RuntimeClientError,
    RuntimeRpcFailureError
  }
})

import {
  buildCurrentWorktreeSelector,
  COMMAND_SPECS,
  main,
  normalizeWorktreeSelector
} from './index'
import { RuntimeClientError } from './runtime-client'

describe('COMMAND_SPECS collision check', () => {
  it('has no duplicate command paths', () => {
    const seen = new Set<string>()
    for (const spec of COMMAND_SPECS) {
      const key = spec.path.join(' ')
      expect(seen.has(key), `Duplicate COMMAND_SPECS path: "${key}"`).toBe(false)
      seen.add(key)
    }
  })
})

describe('orca cli worktree awareness', () => {
  beforeEach(() => {
    callMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('builds the current worktree selector from cwd', () => {
    expect(buildCurrentWorktreeSelector('/tmp/repo/feature')).toBe(
      `path:${path.resolve('/tmp/repo/feature')}`
    )
  })

  it('normalizes active/current worktree selectors to cwd', () => {
    const resolved = path.resolve('/tmp/repo/feature')
    expect(normalizeWorktreeSelector('active', '/tmp/repo/feature')).toBe(`path:${resolved}`)
    expect(normalizeWorktreeSelector('current', '/tmp/repo/feature')).toBe(`path:${resolved}`)
    expect(normalizeWorktreeSelector('branch:feature/foo', '/tmp/repo/feature')).toBe(
      'branch:feature/foo'
    )
  })

  it('shows the enclosing worktree for `worktree current`', async () => {
    callMock
      .mockResolvedValueOnce({
        id: 'req_list',
        ok: true,
        result: {
          worktrees: [
            {
              id: 'repo::/tmp/repo/feature',
              repoId: 'repo',
              path: '/tmp/repo/feature',
              branch: 'feature/foo',
              linkedIssue: null,
              git: {
                path: '/tmp/repo/feature',
                head: 'abc',
                branch: 'feature/foo',
                isBare: false,
                isMainWorktree: false
              },
              displayName: '',
              comment: ''
            }
          ],
          totalCount: 1,
          truncated: false
        },
        _meta: {
          runtimeId: 'runtime-1'
        }
      })
      .mockResolvedValueOnce({
        id: 'req_1',
        ok: true,
        result: {
          worktree: {
            id: 'repo::/tmp/repo/feature',
            branch: 'feature/foo',
            path: '/tmp/repo/feature'
          }
        },
        _meta: {
          runtimeId: 'runtime-1'
        }
      })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['worktree', 'current', '--json'], '/tmp/repo/feature/src')

    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.list', {
      limit: 10_000
    })
    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.show', {
      worktree: `path:${path.resolve('/tmp/repo/feature')}`
    })
    expect(logSpy).toHaveBeenCalledTimes(1)
  })

  it('uses cwd when active is passed to worktree.set', async () => {
    callMock
      .mockResolvedValueOnce({
        id: 'req_list',
        ok: true,
        result: {
          worktrees: [
            {
              id: 'repo::/tmp/repo',
              repoId: 'repo',
              path: '/tmp/repo',
              branch: 'main',
              linkedIssue: null,
              git: {
                path: '/tmp/repo',
                head: 'aaa',
                branch: 'main',
                isBare: false,
                isMainWorktree: false
              },
              displayName: '',
              comment: ''
            },
            {
              id: 'repo::/tmp/repo/feature',
              repoId: 'repo',
              path: '/tmp/repo/feature',
              branch: 'feature/foo',
              linkedIssue: null,
              git: {
                path: '/tmp/repo/feature',
                head: 'abc',
                branch: 'feature/foo',
                isBare: false,
                isMainWorktree: false
              },
              displayName: '',
              comment: ''
            }
          ],
          totalCount: 2,
          truncated: false
        },
        _meta: {
          runtimeId: 'runtime-1'
        }
      })
      .mockResolvedValueOnce({
        id: 'req_1',
        ok: true,
        result: {
          worktree: {
            id: 'repo::/tmp/repo/feature',
            branch: 'feature/foo',
            path: '/tmp/repo/feature',
            comment: 'hello'
          }
        },
        _meta: {
          runtimeId: 'runtime-1'
        }
      })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['worktree', 'set', '--worktree', 'active', '--comment', 'hello', '--json'],
      '/tmp/repo/feature/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.set', {
      worktree: `path:${path.resolve('/tmp/repo/feature')}`,
      displayName: undefined,
      linkedIssue: undefined,
      comment: 'hello'
    })
  })

  it('uses the resolved enclosing worktree for other worktree consumers', async () => {
    callMock
      .mockResolvedValueOnce({
        id: 'req_list',
        ok: true,
        result: {
          worktrees: [
            {
              id: 'repo::/tmp/repo/feature',
              repoId: 'repo',
              path: '/tmp/repo/feature',
              branch: 'feature/foo',
              linkedIssue: null,
              git: {
                path: '/tmp/repo/feature',
                head: 'abc',
                branch: 'feature/foo',
                isBare: false,
                isMainWorktree: false
              },
              displayName: '',
              comment: ''
            }
          ],
          totalCount: 1,
          truncated: false
        },
        _meta: {
          runtimeId: 'runtime-1'
        }
      })
      .mockResolvedValueOnce({
        id: 'req_show',
        ok: true,
        result: {
          worktree: {
            id: 'repo::/tmp/repo/feature',
            branch: 'feature/foo',
            path: '/tmp/repo/feature'
          }
        },
        _meta: {
          runtimeId: 'runtime-1'
        }
      })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['worktree', 'show', '--worktree', 'current', '--json'], '/tmp/repo/feature/src')

    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.show', {
      worktree: `path:${path.resolve('/tmp/repo/feature')}`
    })
  })

  it('uses the resolved enclosing worktree for terminal consumers', async () => {
    callMock
      .mockResolvedValueOnce({
        id: 'req_list',
        ok: true,
        result: {
          worktrees: [
            {
              id: 'repo::/tmp/repo/feature',
              repoId: 'repo',
              path: '/tmp/repo/feature',
              branch: 'feature/foo',
              linkedIssue: null,
              git: {
                path: '/tmp/repo/feature',
                head: 'abc',
                branch: 'feature/foo',
                isBare: false,
                isMainWorktree: false
              },
              displayName: '',
              comment: ''
            }
          ],
          totalCount: 1,
          truncated: false
        },
        _meta: {
          runtimeId: 'runtime-1'
        }
      })
      .mockResolvedValueOnce({
        id: 'req_term',
        ok: true,
        result: {
          terminals: [],
          totalCount: 0,
          truncated: false
        },
        _meta: {
          runtimeId: 'runtime-1'
        }
      })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['terminal', 'list', '--worktree', 'active', '--json'], '/tmp/repo/feature/src')

    expect(callMock).toHaveBeenNthCalledWith(2, 'terminal.list', {
      worktree: `path:${path.resolve('/tmp/repo/feature')}`,
      limit: undefined
    })
  })
})

describe('orca cli browser page targeting', () => {
  beforeEach(() => {
    callMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('passes explicit page ids to snapshot without resolving the current worktree', async () => {
    callMock.mockResolvedValueOnce({
      id: 'req_snapshot',
      ok: true,
      result: {
        browserPageId: 'page-1',
        snapshot: 'tree',
        refs: [],
        url: 'https://example.com',
        title: 'Example'
      },
      _meta: {
        runtimeId: 'runtime-1'
      }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['snapshot', '--page', 'page-1', '--json'], '/tmp/not-an-orca-worktree')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('browser.snapshot', {
      page: 'page-1'
    })
  })

  it('resolves current worktree only when --page is combined with --worktree current', async () => {
    callMock
      .mockResolvedValueOnce({
        id: 'req_list',
        ok: true,
        result: {
          worktrees: [
            {
              id: 'repo::/tmp/repo/feature',
              repoId: 'repo',
              path: '/tmp/repo/feature',
              branch: 'feature/foo',
              linkedIssue: null,
              git: {
                path: '/tmp/repo/feature',
                head: 'abc',
                branch: 'feature/foo',
                isBare: false,
                isMainWorktree: false
              },
              displayName: '',
              comment: ''
            }
          ],
          totalCount: 1,
          truncated: false
        },
        _meta: {
          runtimeId: 'runtime-1'
        }
      })
      .mockResolvedValueOnce({
        id: 'req_snapshot',
        ok: true,
        result: {
          browserPageId: 'page-1',
          snapshot: 'tree',
          refs: [],
          url: 'https://example.com',
          title: 'Example'
        },
        _meta: {
          runtimeId: 'runtime-1'
        }
      })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['snapshot', '--page', 'page-1', '--worktree', 'current', '--json'],
      '/tmp/repo/feature/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.list', {
      limit: 10_000
    })
    expect(callMock).toHaveBeenNthCalledWith(2, 'browser.snapshot', {
      page: 'page-1',
      worktree: `path:${path.resolve('/tmp/repo/feature')}`
    })
  })

  it('passes page-targeted tab switches through without auto-scoping to the current worktree', async () => {
    callMock.mockResolvedValueOnce({
      id: 'req_switch',
      ok: true,
      result: {
        switched: 2,
        browserPageId: 'page-2'
      },
      _meta: {
        runtimeId: 'runtime-1'
      }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['tab', 'switch', '--page', 'page-2', '--json'], '/tmp/repo/feature/src')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('browser.tabSwitch', {
      index: undefined,
      page: 'page-2'
    })
  })

  it('still resolves the current worktree when tab switch --page is combined with --worktree current', async () => {
    callMock
      .mockResolvedValueOnce({
        id: 'req_list',
        ok: true,
        result: {
          worktrees: [
            {
              id: 'repo::/tmp/repo/feature',
              repoId: 'repo',
              path: '/tmp/repo/feature',
              branch: 'feature/foo',
              linkedIssue: null,
              git: {
                path: '/tmp/repo/feature',
                head: 'abc',
                branch: 'feature/foo',
                isBare: false,
                isMainWorktree: false
              },
              displayName: '',
              comment: ''
            }
          ],
          totalCount: 1,
          truncated: false
        },
        _meta: {
          runtimeId: 'runtime-1'
        }
      })
      .mockResolvedValueOnce({
        id: 'req_switch',
        ok: true,
        result: {
          switched: 2,
          browserPageId: 'page-2'
        },
        _meta: {
          runtimeId: 'runtime-1'
        }
      })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['tab', 'switch', '--page', 'page-2', '--worktree', 'current', '--json'],
      '/tmp/repo/feature/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.list', {
      limit: 10_000
    })
    expect(callMock).toHaveBeenNthCalledWith(2, 'browser.tabSwitch', {
      index: undefined,
      page: 'page-2',
      worktree: `path:${path.resolve('/tmp/repo/feature')}`
    })
  })
})

describe('orca cli browser waits and viewport flags', () => {
  beforeEach(() => {
    callMock.mockReset()
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('gives selector waits an explicit RPC timeout budget', async () => {
    callMock.mockResolvedValueOnce({
      id: 'req_wait',
      ok: true,
      result: { ok: true },
      _meta: {
        runtimeId: 'runtime-1'
      }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['wait', '--selector', '#ready', '--worktree', 'all', '--json'],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).toHaveBeenCalledWith(
      'browser.wait',
      {
        selector: '#ready',
        timeout: undefined,
        text: undefined,
        url: undefined,
        load: undefined,
        fn: undefined,
        state: undefined,
        worktree: undefined
      },
      { timeoutMs: 60_000 }
    )
  })

  it('extends selector wait RPC timeout when the user passes --timeout', async () => {
    callMock.mockResolvedValueOnce({
      id: 'req_wait',
      ok: true,
      result: { ok: true },
      _meta: {
        runtimeId: 'runtime-1'
      }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['wait', '--selector', '#ready', '--timeout', '12000', '--worktree', 'all', '--json'],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).toHaveBeenCalledWith(
      'browser.wait',
      {
        selector: '#ready',
        timeout: 12000,
        text: undefined,
        url: undefined,
        load: undefined,
        fn: undefined,
        state: undefined,
        worktree: undefined
      },
      { timeoutMs: 17000 }
    )
  })

  it('does not tell users Orca is down for a generic runtime timeout', async () => {
    callMock.mockRejectedValueOnce(
      new RuntimeClientError(
        'runtime_timeout',
        'Timed out waiting for the Orca runtime to respond.'
      )
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['wait', '--selector', '#ready', '--worktree', 'all'], '/tmp/not-an-orca-worktree')

    expect(errorSpy).toHaveBeenCalledWith('Timed out waiting for the Orca runtime to respond.')
  })

  it('passes the mobile viewport flag through to browser.viewport', async () => {
    callMock.mockResolvedValueOnce({
      id: 'req_viewport',
      ok: true,
      result: {
        width: 375,
        height: 812,
        deviceScaleFactor: 2,
        mobile: true
      },
      _meta: {
        runtimeId: 'runtime-1'
      }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'viewport',
        '--width',
        '375',
        '--height',
        '812',
        '--scale',
        '2',
        '--mobile',
        '--worktree',
        'all',
        '--json'
      ],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).toHaveBeenCalledWith('browser.viewport', {
      width: 375,
      height: 812,
      deviceScaleFactor: 2,
      mobile: true,
      worktree: undefined
    })
  })
})
