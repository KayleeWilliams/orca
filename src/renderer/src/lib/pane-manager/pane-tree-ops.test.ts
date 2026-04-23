import { describe, expect, it, vi } from 'vitest'
import { safeFit } from './pane-tree-ops'
import type { ManagedPaneInternal, ScrollState } from './pane-manager-types'

function createPane({
  proposedCols,
  proposedRows,
  terminalCols,
  terminalRows
}: {
  proposedCols: number
  proposedRows: number
  terminalCols: number
  terminalRows: number
}): ManagedPaneInternal {
  const fit = vi.fn()
  const proposeDimensions = vi.fn(() => ({ cols: proposedCols, rows: proposedRows }))
  const terminal = {
    cols: terminalCols,
    rows: terminalRows,
    buffer: {
      active: {
        viewportY: 0,
        baseY: 0,
        getLine: vi.fn(() => ({ translateToString: () => '' }))
      }
    },
    scrollToBottom: vi.fn(),
    scrollToLine: vi.fn(),
    scrollLines: vi.fn(),
    refresh: vi.fn()
  }

  return {
    id: 1,
    terminal: terminal as never,
    container: {} as never,
    xtermContainer: {} as never,
    linkTooltip: {} as never,
    gpuRenderingEnabled: true,
    fitAddon: {
      fit,
      proposeDimensions
    } as never,
    fitResizeObserver: null,
    pendingObservedFitRafId: null,
    pendingDragFitTimeoutId: null,
    lastDragFitAtMs: null,
    searchAddon: {} as never,
    serializeAddon: {} as never,
    unicode11Addon: {} as never,
    webLinksAddon: {} as never,
    webglAddon: null,
    compositionHandler: null,
    pendingSplitScrollState: null,
    pendingDragScrollState: null
  }
}

describe('safeFit', () => {
  it('skips drag-frame refits when the pane grid dimensions did not change', () => {
    const pane = createPane({
      proposedCols: 120,
      proposedRows: 32,
      terminalCols: 120,
      terminalRows: 32
    })

    safeFit(pane)

    expect(pane.fitAddon.fit).not.toHaveBeenCalled()
  })

  it('still refits when the proposed grid dimensions changed', () => {
    const pane = createPane({
      proposedCols: 100,
      proposedRows: 32,
      terminalCols: 120,
      terminalRows: 32
    })

    safeFit(pane)

    expect(pane.fitAddon.fit).toHaveBeenCalledTimes(1)
    expect(pane.terminal.refresh).toHaveBeenCalledWith(0, pane.terminal.rows - 1)
  })

  it('still refits when a split-scroll lock is active and the grid changed', () => {
    const pane = createPane({
      proposedCols: 100,
      proposedRows: 32,
      terminalCols: 120,
      terminalRows: 32
    })
    pane.pendingSplitScrollState = {
      wasAtBottom: true,
      firstVisibleLineContent: '',
      viewportY: 0,
      totalLines: 32
    } satisfies ScrollState

    safeFit(pane)

    expect(pane.fitAddon.fit).toHaveBeenCalledTimes(1)
    expect(pane.terminal.refresh).toHaveBeenCalledWith(0, pane.terminal.rows - 1)
  })

  it('fits immediately on the first drag-time resize', () => {
    const pane = createPane({
      proposedCols: 100,
      proposedRows: 32,
      terminalCols: 120,
      terminalRows: 32
    })
    pane.pendingDragScrollState = {
      wasAtBottom: true,
      firstVisibleLineContent: '',
      viewportY: 0,
      totalLines: 32
    } satisfies ScrollState

    safeFit(pane)

    expect(pane.fitAddon.fit).toHaveBeenCalledTimes(1)
    expect(pane.terminal.refresh).toHaveBeenCalledWith(0, pane.terminal.rows - 1)
  })

  it('still performs the final refit when drag-time fits are explicitly allowed', () => {
    const pane = createPane({
      proposedCols: 100,
      proposedRows: 32,
      terminalCols: 120,
      terminalRows: 32
    })
    pane.pendingDragScrollState = {
      wasAtBottom: true,
      firstVisibleLineContent: '',
      viewportY: 0,
      totalLines: 32
    } satisfies ScrollState

    safeFit(pane, { allowWhileDragLocked: true })

    expect(pane.fitAddon.fit).toHaveBeenCalledTimes(1)
    expect(pane.terminal.refresh).toHaveBeenCalledWith(0, pane.terminal.rows - 1)
  })

  it('throttles repeated drag-time refits to a capped cadence', () => {
    vi.useFakeTimers()
    const nowSpy = vi.spyOn(performance, 'now')
    const pane = createPane({
      proposedCols: 100,
      proposedRows: 32,
      terminalCols: 120,
      terminalRows: 32
    })
    pane.pendingDragScrollState = {
      wasAtBottom: true,
      firstVisibleLineContent: '',
      viewportY: 0,
      totalLines: 32
    } satisfies ScrollState

    let nowMs = 0
    nowSpy.mockImplementation(() => nowMs)

    safeFit(pane)
    expect(pane.fitAddon.fit).toHaveBeenCalledTimes(1)

    pane.fitAddon.fit.mockClear()
    ;(pane.terminal.refresh as ReturnType<typeof vi.fn>).mockClear()

    nowMs = 10
    safeFit(pane)

    expect(pane.fitAddon.fit).not.toHaveBeenCalled()
    expect(pane.pendingDragFitTimeoutId).not.toBeNull()

    nowMs = 50
    vi.advanceTimersByTime(40)

    expect(pane.fitAddon.fit).toHaveBeenCalledTimes(1)
    expect(pane.terminal.refresh).toHaveBeenCalledWith(0, pane.terminal.rows - 1)

    nowSpy.mockRestore()
    vi.useRealTimers()
  })

  it('does not refresh when the pane grid dimensions did not change', () => {
    const pane = createPane({
      proposedCols: 120,
      proposedRows: 32,
      terminalCols: 120,
      terminalRows: 32
    })

    safeFit(pane)

    expect(pane.terminal.refresh).not.toHaveBeenCalled()
  })
})
