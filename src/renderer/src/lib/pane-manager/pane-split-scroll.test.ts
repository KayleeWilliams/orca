import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import type { Terminal as XtermTerminal } from '@xterm/xterm'
import type { ManagedPaneInternal, ScrollState } from './pane-manager-types'
import { scheduleSplitScrollRestore } from './pane-split-scroll'

/**
 * Why this suite exists:
 *   PR #1298 added `scheduleSplitScrollRestore` to preserve scroll position
 *   through split-induced DOM reparenting. The 200ms authoritative phase
 *   (and the earlier double-rAF phase) each run scroll restore +
 *   `terminal.refresh(0, rows-1)` on the pane. When a full-screen TUI
 *   (Claude Code, vim, less) is drawing at the moment the phase fires, the
 *   restore path repaints rows from xterm's buffer mid-draw and knocks the
 *   TUI's cursor one row off — the bug surfaced as typed input appearing
 *   one row below where the TUI expected, with residual fragments left at
 *   the old cursor row.
 *
 * What this suite locks down:
 *   - When the terminal is on the alt-buffer (TUI active) the restore/
 *     refresh pair is skipped at *both* phases. The TUI keeps full control
 *     of its cursor.
 *   - When the terminal is on the normal buffer, the restore/refresh pair
 *     still runs — that is the path the #1298 fix originally needed for a
 *     post-split scrollback repaint.
 *   - WebGL reattach still fires on alt-buffer: the dead-canvas symptom
 *     that #1298 fixed still matters; only the scroll-restore side effect
 *     needs to be suppressed.
 */

function writeSync(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

type TestPane = {
  id: number
  terminal: XtermTerminal
  pendingSplitScrollState: ScrollState | null
  refreshSpy: ReturnType<typeof vi.fn>
}

function makePane(term: Terminal, id = 1): TestPane {
  const refreshSpy = vi.fn()
  // Why: the DOM Terminal exposes `refresh(start, end)` for external repaint;
  // the headless build does not, because it has no renderer. Stub it in so we
  // can assert whether the scheduler chose to call refresh on this pane —
  // that is the exact call that was clobbering TUI cursor state before the
  // alt-buffer guard landed.
  const patched = term as unknown as XtermTerminal & { refresh: typeof refreshSpy }
  patched.refresh = refreshSpy
  return {
    id,
    terminal: patched,
    pendingSplitScrollState: null,
    refreshSpy
  }
}

function toInternal(pane: TestPane): ManagedPaneInternal {
  return pane as unknown as ManagedPaneInternal
}

const idleScrollState: ScrollState = {
  wasAtBottom: true,
  firstVisibleLineContent: '',
  viewportY: 0,
  totalLines: 0
}

// Why: xterm's write() schedules its own async flush on a timer, which
// deadlocks with vi.useFakeTimers(). Drive escape sequences synchronously by
// briefly switching to real timers.
async function writeWithRealTimers(term: Terminal, data: string): Promise<void> {
  vi.useRealTimers()
  try {
    await writeSync(term, data)
  } finally {
    vi.useFakeTimers()
  }
}

beforeEach(() => {
  // Why: vitest runs in node env (see config/vitest.config.ts), which has no
  // requestAnimationFrame. The scheduler uses a double-rAF for its first
  // phase; polyfill it so the scheduled work is reachable under fake timers.
  ;(
    globalThis as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number }
  ).requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16) as unknown as number
})

afterEach(() => {
  delete (globalThis as unknown as { requestAnimationFrame?: unknown }).requestAnimationFrame
  vi.useRealTimers()
})

describe('scheduleSplitScrollRestore', () => {
  it('skips scroll restore + refresh at the 200ms phase when the TUI alt-buffer is active', async () => {
    vi.useFakeTimers()
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    // Enter alt-buffer — xterm switches buffer.active.type to 'alternate'.
    await writeWithRealTimers(term, '\x1b[?1049h')
    expect(term.buffer.active.type).toBe('alternate')

    const pane = makePane(term)
    pane.pendingSplitScrollState = idleScrollState

    scheduleSplitScrollRestore(
      () => toInternal(pane),
      pane.id,
      idleScrollState,
      () => false
    )

    await vi.advanceTimersByTimeAsync(250)

    expect(pane.refreshSpy).not.toHaveBeenCalled()
    // The scroll lock must still be cleared — otherwise safeFit /
    // ResizeObserver restores would stay disabled forever on this pane.
    expect(pane.pendingSplitScrollState).toBeNull()

    term.dispose()
  })

  it('still reattaches WebGL on alt-buffer (the dead-canvas fix from #1298 must not regress)', async () => {
    vi.useFakeTimers()
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    await writeWithRealTimers(term, '\x1b[?1049h')

    const pane = makePane(term)
    pane.pendingSplitScrollState = idleScrollState
    const reattach = vi.fn()

    scheduleSplitScrollRestore(
      () => toInternal(pane),
      pane.id,
      idleScrollState,
      () => false,
      reattach
    )

    await vi.advanceTimersByTimeAsync(250)

    expect(reattach).toHaveBeenCalledWith(toInternal(pane))

    term.dispose()
  })

  it('runs scroll restore + refresh at the 200ms phase on the normal buffer', async () => {
    vi.useFakeTimers()
    const term = new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true })
    // Leave on normal buffer so the guard path exercises the non-alt branch.
    await writeWithRealTimers(term, 'hello\r\n')
    expect(term.buffer.active.type).toBe('normal')

    const pane = makePane(term)
    pane.pendingSplitScrollState = idleScrollState

    scheduleSplitScrollRestore(
      () => toInternal(pane),
      pane.id,
      idleScrollState,
      () => false
    )

    await vi.advanceTimersByTimeAsync(250)

    expect(pane.refreshSpy).toHaveBeenCalled()
    expect(pane.pendingSplitScrollState).toBeNull()

    term.dispose()
  })
})
