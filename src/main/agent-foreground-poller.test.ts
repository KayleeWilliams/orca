import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgentForegroundPoller } from './agent-foreground-poller'

describe('createAgentForegroundPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('emits shell exactly once on non-shell→shell transition', async () => {
    const emitShell = vi.fn()
    const getForegroundProcess = vi
      .fn<(id: string) => Promise<string | null>>()
      .mockResolvedValueOnce('codex')
      .mockResolvedValueOnce('zsh')
      .mockResolvedValueOnce('zsh')

    const poller = createAgentForegroundPoller({
      getForegroundProcess,
      emitShell,
      intervalMs: 2000
    })

    poller.trackPane('tab-1:1', 'pty-1')

    await poller.pollOnce()
    await poller.pollOnce()
    await poller.pollOnce()

    expect(emitShell).toHaveBeenCalledTimes(1)
    expect(emitShell).toHaveBeenCalledWith('pty-1')
  })

  it('does not emit when foreground stays non-shell', async () => {
    const emitShell = vi.fn()
    const getForegroundProcess = vi
      .fn<(id: string) => Promise<string | null>>()
      .mockResolvedValue('codex')

    const poller = createAgentForegroundPoller({
      getForegroundProcess,
      emitShell,
      intervalMs: 2000
    })

    poller.trackPane('tab-1:1', 'pty-1')

    await poller.pollOnce()
    await poller.pollOnce()
    await poller.pollOnce()

    expect(emitShell).not.toHaveBeenCalled()
  })

  it('does not emit when getForegroundProcess returns null', async () => {
    const emitShell = vi.fn()
    const getForegroundProcess = vi
      .fn<(id: string) => Promise<string | null>>()
      .mockResolvedValue(null)

    const poller = createAgentForegroundPoller({
      getForegroundProcess,
      emitShell,
      intervalMs: 2000
    })

    poller.trackPane('tab-1:1', 'pty-1')

    await poller.pollOnce()
    await poller.pollOnce()

    expect(emitShell).not.toHaveBeenCalled()
  })

  it('does not emit when getForegroundProcess throws', async () => {
    const emitShell = vi.fn()
    const getForegroundProcess = vi
      .fn<(id: string) => Promise<string | null>>()
      .mockRejectedValue(new Error('platform not supported'))

    const poller = createAgentForegroundPoller({
      getForegroundProcess,
      emitShell,
      intervalMs: 2000
    })

    poller.trackPane('tab-1:1', 'pty-1')

    await poller.pollOnce()
    await poller.pollOnce()

    expect(emitShell).not.toHaveBeenCalled()
  })

  it('does not emit on the first poll when foreground is already a shell', async () => {
    // Why: the tracker can only be sure an agent *exited* if it first saw a
    // non-shell foreground. If the first observation is already a shell, we
    // cannot distinguish "agent already gone" from "agent never started",
    // and firing here would incorrectly drop rows for panes that are simply
    // sitting at a shell prompt with stale status.
    const emitShell = vi.fn()
    const getForegroundProcess = vi
      .fn<(id: string) => Promise<string | null>>()
      .mockResolvedValue('zsh')

    const poller = createAgentForegroundPoller({
      getForegroundProcess,
      emitShell,
      intervalMs: 2000
    })

    poller.trackPane('tab-1:1', 'pty-1')

    await poller.pollOnce()
    await poller.pollOnce()

    expect(emitShell).not.toHaveBeenCalled()
  })

  it('stops polling once no panes are tracked', () => {
    const emitShell = vi.fn()
    const getForegroundProcess = vi
      .fn<(id: string) => Promise<string | null>>()
      .mockResolvedValue('codex')

    const poller = createAgentForegroundPoller({
      getForegroundProcess,
      emitShell,
      intervalMs: 2000
    })

    poller.trackPane('tab-1:1', 'pty-1')
    expect(poller.trackedCount()).toBe(1)

    poller.untrackPane('tab-1:1')
    expect(poller.trackedCount()).toBe(0)

    // Advance timers to ensure no further polling happens after untrack.
    vi.advanceTimersByTime(10_000)
    expect(getForegroundProcess).not.toHaveBeenCalled()
  })

  it('ignores late poll results for panes that were untracked mid-flight', async () => {
    const emitShell = vi.fn()
    let resolveFirst: ((value: string | null) => void) | null = null
    const getForegroundProcess = vi.fn<(id: string) => Promise<string | null>>(
      () =>
        new Promise<string | null>((resolve) => {
          resolveFirst = resolve
        })
    )

    const poller = createAgentForegroundPoller({
      getForegroundProcess,
      emitShell,
      intervalMs: 2000
    })

    poller.trackPane('tab-1:1', 'pty-1')
    const first = poller.pollOnce()
    poller.untrackPane('tab-1:1')
    resolveFirst!('zsh')
    await first

    expect(emitShell).not.toHaveBeenCalled()
  })
})
