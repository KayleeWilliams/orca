/* oxlint-disable max-lines -- Why: cohesive test suite covering paneLeafId,
   buildFontFamily, serializePaneTree, serializeTerminalLayout,
   collectLeafIdsInReplayCreationOrder, and restoreScrollbackBuffers for the
   same layout-serialization module. Splitting by function would scatter
   related fixtures and the xterm round-trip helpers. */
import { describe, expect, it, beforeAll } from 'vitest'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import type { TerminalPaneLayoutNode } from '../../../../shared/types'
import { type ReplayingPanesRef } from './replay-guard'

// ---------------------------------------------------------------------------
// Provide a minimal HTMLElement so `instanceof HTMLElement` passes in Node env
// ---------------------------------------------------------------------------
class MockHTMLElement {
  classList: { contains: (cls: string) => boolean }
  dataset: Record<string, string>
  children: MockHTMLElement[]
  style: Record<string, string>
  firstElementChild: MockHTMLElement | null

  constructor(opts: {
    classList?: string[]
    dataset?: Record<string, string>
    children?: MockHTMLElement[]
    style?: Record<string, string>
    firstElementChild?: MockHTMLElement | null
  }) {
    const classes = opts.classList ?? []
    this.classList = { contains: (cls: string) => classes.includes(cls) }
    this.dataset = opts.dataset ?? {}
    this.children = opts.children ?? []
    this.style = opts.style ?? {}
    this.firstElementChild = opts.firstElementChild ?? null
  }
}

beforeAll(() => {
  // Expose globally so `child instanceof HTMLElement` works inside the module
  ;(globalThis as unknown as Record<string, unknown>).HTMLElement = MockHTMLElement
})

import {
  paneLeafId,
  buildFontFamily,
  serializePaneTree,
  serializeTerminalLayout,
  EMPTY_LAYOUT,
  collectLeafIdsInOrder,
  collectLeafIdsInReplayCreationOrder,
  restoreScrollbackBuffers
} from './layout-serialization'

// ---------------------------------------------------------------------------
// Helper to create mock elements
// ---------------------------------------------------------------------------
function mockElement(opts: {
  classList?: string[]
  dataset?: Record<string, string>
  children?: MockHTMLElement[]
  style?: Record<string, string>
  firstElementChild?: MockHTMLElement | null
}): HTMLElement {
  return new MockHTMLElement(opts) as unknown as HTMLElement
}

// ---------------------------------------------------------------------------
// paneLeafId
// ---------------------------------------------------------------------------
describe('paneLeafId', () => {
  it('returns "pane:0" for paneId 0', () => {
    expect(paneLeafId(0)).toBe('pane:0')
  })

  it('returns "pane:1" for paneId 1', () => {
    expect(paneLeafId(1)).toBe('pane:1')
  })

  it('returns "pane:42" for paneId 42', () => {
    expect(paneLeafId(42)).toBe('pane:42')
  })
})

// ---------------------------------------------------------------------------
// buildFontFamily
// ---------------------------------------------------------------------------
const FULL_FALLBACK =
  '"SF Mono", "Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Symbols Nerd Font Mono", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", monospace'

describe('buildFontFamily', () => {
  it('puts custom font first with full cross-platform fallback chain', () => {
    const result = buildFontFamily('JetBrains Mono')
    expect(result).toBe(`"JetBrains Mono", ${FULL_FALLBACK}`)
  })

  it('does not duplicate SF Mono when it is the input', () => {
    const result = buildFontFamily('SF Mono')
    expect(result).toBe(
      '"SF Mono", "Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Symbols Nerd Font Mono", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", monospace'
    )
  })

  it('returns full fallback chain for empty string', () => {
    const result = buildFontFamily('')
    expect(result).toBe(FULL_FALLBACK)
  })

  it('treats whitespace-only string same as empty', () => {
    const result = buildFontFamily('   ')
    expect(result).toBe(FULL_FALLBACK)
  })

  it('does not duplicate when font name contains "sf mono" (case-insensitive)', () => {
    const result = buildFontFamily('My SF Mono Custom')
    expect(result).toBe(
      '"My SF Mono Custom", "Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Symbols Nerd Font Mono", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", monospace'
    )
  })

  it('does not duplicate Consolas when it is the input', () => {
    const result = buildFontFamily('Consolas')
    expect(result).toBe(
      '"Consolas", "SF Mono", "Menlo", "Monaco", "Cascadia Mono", "DejaVu Sans Mono", "Liberation Mono", "Symbols Nerd Font Mono", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", monospace'
    )
  })

  it('does not duplicate MesloLGS Nerd Font when it is the input', () => {
    const result = buildFontFamily('MesloLGS Nerd Font')
    expect(result).toBe(
      '"MesloLGS Nerd Font", "SF Mono", "Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Symbols Nerd Font Mono", "JetBrainsMono Nerd Font", "Hack Nerd Font", monospace'
    )
  })
})

// ---------------------------------------------------------------------------
// serializePaneTree
// ---------------------------------------------------------------------------
describe('serializePaneTree', () => {
  it('returns null for null input', () => {
    expect(serializePaneTree(null)).toBeNull()
  })

  it('returns a leaf node for a single pane', () => {
    const pane = mockElement({ classList: ['pane'], dataset: { paneId: '1' } })
    expect(serializePaneTree(pane)).toEqual({ type: 'leaf', leafId: 'pane:1' })
  })

  it('returns null for a pane with non-numeric paneId', () => {
    const pane = mockElement({ classList: ['pane'], dataset: { paneId: 'abc' } })
    expect(serializePaneTree(pane)).toBeNull()
  })

  it('returns null for element that is neither pane nor pane-split', () => {
    const el = mockElement({ classList: ['random-class'] })
    expect(serializePaneTree(el)).toBeNull()
  })

  it('returns a vertical split node with two pane children', () => {
    const first = new MockHTMLElement({ classList: ['pane'], dataset: { paneId: '1' } })
    const second = new MockHTMLElement({ classList: ['pane'], dataset: { paneId: '2' } })
    const split = mockElement({ classList: ['pane-split'], children: [first, second] })

    expect(serializePaneTree(split)).toEqual({
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: 'pane:1' },
      second: { type: 'leaf', leafId: 'pane:2' }
    })
  })

  it('returns horizontal direction when split has is-horizontal class', () => {
    const first = new MockHTMLElement({ classList: ['pane'], dataset: { paneId: '3' } })
    const second = new MockHTMLElement({ classList: ['pane'], dataset: { paneId: '4' } })
    const split = mockElement({
      classList: ['pane-split', 'is-horizontal'],
      children: [first, second]
    })

    expect(serializePaneTree(split)).toEqual({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', leafId: 'pane:3' },
      second: { type: 'leaf', leafId: 'pane:4' }
    })
  })

  it('captures flex ratio when children have unequal flex', () => {
    const first = new MockHTMLElement({
      classList: ['pane'],
      dataset: { paneId: '1' },
      style: { flex: '3' }
    })
    const second = new MockHTMLElement({
      classList: ['pane'],
      dataset: { paneId: '2' },
      style: { flex: '1' }
    })
    const split = mockElement({ classList: ['pane-split'], children: [first, second] })

    const result = serializePaneTree(split)
    expect(result).toEqual({
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: 'pane:1' },
      second: { type: 'leaf', leafId: 'pane:2' },
      ratio: 0.75
    })
  })

  it('omits ratio when flex values are equal (both 1)', () => {
    const first = new MockHTMLElement({
      classList: ['pane'],
      dataset: { paneId: '1' },
      style: { flex: '1' }
    })
    const second = new MockHTMLElement({
      classList: ['pane'],
      dataset: { paneId: '2' },
      style: { flex: '1' }
    })
    const split = mockElement({ classList: ['pane-split'], children: [first, second] })

    const result = serializePaneTree(split)
    expect(result).not.toHaveProperty('ratio')
  })

  it('handles nested splits recursively', () => {
    const leaf1 = new MockHTMLElement({ classList: ['pane'], dataset: { paneId: '1' } })
    const leaf2 = new MockHTMLElement({ classList: ['pane'], dataset: { paneId: '2' } })
    const leaf3 = new MockHTMLElement({ classList: ['pane'], dataset: { paneId: '3' } })

    const innerSplit = new MockHTMLElement({
      classList: ['pane-split', 'is-horizontal'],
      children: [leaf2, leaf3]
    })
    const outerSplit = mockElement({
      classList: ['pane-split'],
      children: [leaf1, innerSplit]
    })

    expect(serializePaneTree(outerSplit)).toEqual({
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: 'pane:1' },
      second: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: 'pane:2' },
        second: { type: 'leaf', leafId: 'pane:3' }
      }
    })
  })
})

// ---------------------------------------------------------------------------
// serializeTerminalLayout
// ---------------------------------------------------------------------------
describe('serializeTerminalLayout', () => {
  it('returns EMPTY_LAYOUT equivalent when root is null', () => {
    const result = serializeTerminalLayout(null, null, null)
    expect(result).toEqual(EMPTY_LAYOUT)
  })

  it('returns null root when root has no firstElementChild', () => {
    const root = mockElement({}) as unknown as HTMLDivElement
    const result = serializeTerminalLayout(root, 5, null)
    expect(result).toEqual({
      root: null,
      activeLeafId: 'pane:5',
      expandedLeafId: null
    })
  })
})

// ---------------------------------------------------------------------------
// collectLeafIdsInReplayCreationOrder
// ---------------------------------------------------------------------------
describe('collectLeafIdsInReplayCreationOrder', () => {
  it('matches replayTerminalLayout pane creation order for nested left splits', () => {
    const layout: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'vertical',
      first: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: 'A' },
        second: { type: 'leaf', leafId: 'B' }
      },
      second: { type: 'leaf', leafId: 'C' }
    }

    expect(collectLeafIdsInOrder(layout)).toEqual(['A', 'B', 'C'])
    expect(collectLeafIdsInReplayCreationOrder(layout)).toEqual(['A', 'C', 'B'])
  })

  it('matches replayTerminalLayout pane creation order for nested right splits', () => {
    const layout: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: 'A' },
      second: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: 'B' },
        second: { type: 'leaf', leafId: 'C' }
      }
    }

    expect(collectLeafIdsInReplayCreationOrder(layout)).toEqual(['A', 'B', 'C'])
  })
})

// ---------------------------------------------------------------------------
// restoreScrollbackBuffers — cursor position preservation
//
// These tests lock in the cursor-placement contract documented on the
// function: the serialized buffer is replayed verbatim, followed only by
// POST_REPLAY_MODE_RESET. Two prior heuristics caused the "cursor drifts
// below the TUI input box" bug after app restart:
//   1. Trimming from the last `\x1b[?1049h` to "exit alt-screen" also
//      discarded SerializeAddon's trailing cursor-position tail.
//   2. Appending `\r\n` for "PROMPT_EOL_MARK protection" pushed the cursor
//      one extra row down.
// ---------------------------------------------------------------------------

type CapturedTerminal = {
  terminal: Terminal
  serializer: SerializeAddon
  write: (data: string) => Promise<void>
}

function createCapturedTerminal(): CapturedTerminal {
  const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  const serializer = new SerializeAddon()
  terminal.loadAddon(serializer)
  const write = (data: string): Promise<void> =>
    new Promise<void>((resolve) => terminal.write(data, () => resolve()))
  return { terminal, serializer, write }
}

function makeFakePaneManager(panes: ManagedPane[]): PaneManager {
  // Why the `as unknown as`: restoreScrollbackBuffers only calls
  // `manager.getPanes()`; building a real PaneManager would require a DOM.
  return { getPanes: () => panes } as unknown as PaneManager
}

function waitForWriteDrain(terminal: Terminal): Promise<void> {
  return new Promise<void>((resolve) => terminal.write('', () => resolve()))
}

describe('restoreScrollbackBuffers', () => {
  it('places cursor where SerializeAddon captured it for alt-screen TUIs (prior bug: cursor landed one row below)', async () => {
    // Capture: simulate a Claude Code-like TUI that switched to the alt
    // buffer, drew content, and left its cursor at column 15, row 3 (the
    // "input box" row, not the last row of output).
    const capture = createCapturedTerminal()
    await capture.write('\x1b[?1049h') // enter alt screen
    await capture.write('\x1b[H') // home
    await capture.write('╭─ Claude\r\n')
    await capture.write('│ previous output line 1\r\n')
    await capture.write('│ previous output line 2\r\n')
    await capture.write('╰─\r\n')
    // Move the cursor to row 3 (0-indexed), col 15 — this represents the
    // TUI's input position, which is ABOVE the last written row.
    await capture.write('\x1b[4;16H') // CSI is 1-indexed: row 4 col 16 => (15,3)
    const serialized = capture.serializer.serialize()
    expect(serialized).toContain('\x1b[?1049h')

    // Restore into a fresh terminal via restoreScrollbackBuffers.
    const restore = createCapturedTerminal()
    const pane = { id: 1, terminal: restore.terminal } as unknown as ManagedPane
    const manager = makeFakePaneManager([pane])
    const replayingPanesRef: ReplayingPanesRef = { current: new Map() }

    restoreScrollbackBuffers(
      manager,
      { 'pane:1': serialized },
      new Map([['pane:1', 1]]),
      replayingPanesRef
    )
    await waitForWriteDrain(restore.terminal)

    // The alt buffer must be active and the cursor must match capture time.
    expect(restore.terminal.buffer.active.type).toBe('alternate')
    expect(restore.terminal.buffer.active.cursorX).toBe(15)
    expect(restore.terminal.buffer.active.cursorY).toBe(3)
  })

  it('places cursor correctly for normal-buffer TUIs that leave cursor above last-drawn row (prior bug: SerializeAddon relative cursor tail drifted the cursor one row below the input prompt)', async () => {
    // This is the REAL-WORLD scenario that escaped the alt-screen test above.
    // A TUI (Claude Code, in the reproducer) draws its UI directly on the
    // normal buffer with scrollback history present. SerializeAddon emits a
    // trailing relative-cursor-move tail like `\x1b[NA\x1b[MD` that counts
    // rows up from the last content cell it emitted to the terminal's real
    // cursor. When the last-drawn row is BELOW the cursor's logical
    // position (the bottom border and status lines live below the input
    // prompt), the relative math lands the cursor on the border row after
    // restore.
    //
    // The fix: `captureBuffers` appends an authoritative absolute
    // `CSI row;col H` after SerializeAddon's output using the terminal's
    // live cursor position at save time. We simulate that here by appending
    // the same absolute positioner before calling restoreScrollbackBuffers.
    // The absolute positioner is the last cursor-move seen by the restore
    // emulator, so it overrides whatever relative math SerializeAddon used.
    const capture = createCapturedTerminal()
    // Produce enough scrollback that the serializer takes the non-fixup
    // branch (`_buffer.length - _firstRow > terminal.rows`), which is where
    // the relative cursor tail drift manifests in the real bug.
    for (let i = 0; i < 40; i++) {
      await capture.write(`scrollback line ${i}\r\n`)
    }
    // Now the cursor is at the bottom of the visible region. Draw the TUI:
    // input prompt, then border/status lines BELOW it, then park cursor
    // back on the prompt without redrawing the rows between.
    const promptRow = capture.terminal.buffer.active.cursorY // 0-indexed
    await capture.write('> ')
    // Move down and draw filler rows, which become the "last drawn cells"
    // from SerializeAddon's perspective.
    await capture.write(`\x1b[${promptRow + 3};1H──────────────────────`)
    await capture.write(`\x1b[${promptRow + 4};1Hstatus line`)
    // Park cursor back on the input prompt (1-indexed CUP).
    await capture.write(`\x1b[${promptRow + 1};3H`)

    // Capture-time cursor is on the input prompt.
    expect(capture.terminal.buffer.active.cursorX).toBe(2)
    expect(capture.terminal.buffer.active.cursorY).toBe(promptRow)

    // Simulate what `captureBuffers` in TerminalPane.tsx now does: take
    // SerializeAddon's output and append an authoritative absolute CUP
    // using the captured terminal's live cursor position.
    const rawSerialized = capture.serializer.serialize()
    const cursorRow = capture.terminal.buffer.active.cursorY + 1
    const cursorCol = capture.terminal.buffer.active.cursorX + 1
    const serialized = `${rawSerialized}\x1b[${cursorRow};${cursorCol}H`

    const restore = createCapturedTerminal()
    const pane = { id: 1, terminal: restore.terminal } as unknown as ManagedPane
    const manager = makeFakePaneManager([pane])
    const replayingPanesRef: ReplayingPanesRef = { current: new Map() }

    restoreScrollbackBuffers(
      manager,
      { 'pane:1': serialized },
      new Map([['pane:1', 1]]),
      replayingPanesRef
    )
    await waitForWriteDrain(restore.terminal)

    // Cursor must land on the input prompt row, not the border below.
    expect(restore.terminal.buffer.active.cursorX).toBe(2)
    expect(restore.terminal.buffer.active.cursorY).toBe(promptRow)
  })

  it('does not append a spurious newline after non-newline-terminated content (prior bug: \\r\\n pushed cursor down one extra row)', async () => {
    // Capture: output that ends mid-row, without a trailing newline — the
    // scenario PROMPT_EOL_MARK would normally handle at the shell layer.
    const capture = createCapturedTerminal()
    await capture.write('line one\r\n')
    await capture.write('partial line without newline') // no \r\n at end
    const serialized = capture.serializer.serialize()

    // Cursor after capture sits on row 1 (0-indexed), column 28.
    expect(capture.terminal.buffer.active.cursorY).toBe(1)

    const restore = createCapturedTerminal()
    const pane = { id: 1, terminal: restore.terminal } as unknown as ManagedPane
    const manager = makeFakePaneManager([pane])
    const replayingPanesRef: ReplayingPanesRef = { current: new Map() }

    restoreScrollbackBuffers(
      manager,
      { 'pane:1': serialized },
      new Map([['pane:1', 1]]),
      replayingPanesRef
    )
    await waitForWriteDrain(restore.terminal)

    // Cursor stays on the partial-content row, not one row below.
    expect(restore.terminal.buffer.active.cursorY).toBe(1)
    // And the row below must be empty — a stray \r\n append would drop the
    // cursor onto a next row that, by transitivity, we'd also see content on
    // if the row was somehow shifted.
    const rowBelow = restore.terminal.buffer.active.getLine(2)?.translateToString(true) ?? ''
    expect(rowBelow.trim()).toBe('')
  })
})
