import { afterEach, describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { HeadlessEmulator } from './headless-emulator'

describe('HeadlessEmulator', () => {
  let emulator: HeadlessEmulator

  afterEach(() => {
    emulator?.dispose()
  })

  describe('construction', () => {
    it('creates with specified dimensions', () => {
      emulator = new HeadlessEmulator({ cols: 120, rows: 40 })
      const snapshot = emulator.getSnapshot()
      expect(snapshot.cols).toBe(120)
      expect(snapshot.rows).toBe(40)
    })

    it('defaults cwd to null', () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      expect(emulator.getSnapshot().cwd).toBeNull()
    })
  })

  describe('write and snapshot', () => {
    it('captures written text in snapshot', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('hello world')

      const snapshot = emulator.getSnapshot()
      expect(snapshot.snapshotAnsi).toContain('hello world')
    })

    it('captures colored text', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('\x1b[31mred text\x1b[0m')

      const snapshot = emulator.getSnapshot()
      expect(snapshot.snapshotAnsi).toContain('red text')
    })
  })

  describe('OSC-7 CWD tracking', () => {
    it('parses OSC-7 file URI to extract CWD', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('\x1b]7;file://localhost/Users/test/project\x07')

      expect(emulator.getSnapshot().cwd).toBe('/Users/test/project')
    })

    it('handles OSC-7 with empty host', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('\x1b]7;file:///home/user/work\x07')

      expect(emulator.getSnapshot().cwd).toBe('/home/user/work')
    })

    it('updates CWD when new OSC-7 arrives', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('\x1b]7;file:///first\x07')
      expect(emulator.getSnapshot().cwd).toBe('/first')

      await emulator.write('\x1b]7;file:///second\x07')
      expect(emulator.getSnapshot().cwd).toBe('/second')
    })

    it('decodes percent-encoded paths', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('\x1b]7;file:///Users/test/my%20project\x07')

      expect(emulator.getSnapshot().cwd).toBe('/Users/test/my project')
    })

    it('normalizes Windows drive-letter OSC-7 paths', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'win32' })

      try {
        await emulator.write('\x1b]7;file:///C:/Users/test/project\x07')
      } finally {
        if (platform) {
          Object.defineProperty(process, 'platform', platform)
        }
      }

      expect(emulator.getSnapshot().cwd).toBe('C:/Users/test/project')
    })

    it('preserves Windows UNC OSC-7 paths', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'win32' })

      try {
        await emulator.write('\x1b]7;file://server/share/project\x07')
      } finally {
        if (platform) {
          Object.defineProperty(process, 'platform', platform)
        }
      }

      expect(emulator.getSnapshot().cwd).toBe('\\\\server\\share\\project')
    })

    it('handles OSC-7 with ST terminator', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('\x1b]7;file:///path/here\x1b\\')

      expect(emulator.getSnapshot().cwd).toBe('/path/here')
    })
  })

  describe('resize', () => {
    it('updates dimensions', () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      emulator.resize(120, 40)

      const snapshot = emulator.getSnapshot()
      expect(snapshot.cols).toBe(120)
      expect(snapshot.rows).toBe(40)
    })
  })

  describe('clear scrollback (CSI 3J)', () => {
    it('detects CSI 3J and clears scrollback', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      // Write enough lines to push into scrollback
      const lines = Array.from({ length: 30 }, (_, i) => `line ${i}\r\n`).join('')
      await emulator.write(lines)

      const before = emulator.getSnapshot()
      expect(before.scrollbackLines).toBeGreaterThan(0)

      await emulator.write('\x1b[3J')
      const after = emulator.getSnapshot()
      expect(after.scrollbackLines).toBe(0)
    })
  })

  describe('terminal modes', () => {
    it('tracks bracketed paste mode', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      expect(emulator.getSnapshot().modes.bracketedPaste).toBe(false)

      await emulator.write('\x1b[?2004h')
      expect(emulator.getSnapshot().modes.bracketedPaste).toBe(true)

      await emulator.write('\x1b[?2004l')
      expect(emulator.getSnapshot().modes.bracketedPaste).toBe(false)
    })

    it('tracks alternate screen mode', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      expect(emulator.getSnapshot().modes.alternateScreen).toBe(false)

      await emulator.write('\x1b[?1049h')
      expect(emulator.getSnapshot().modes.alternateScreen).toBe(true)

      await emulator.write('\x1b[?1049l')
      expect(emulator.getSnapshot().modes.alternateScreen).toBe(false)
    })
  })

  describe('rehydration sequences', () => {
    it('generates rehydration for non-default modes', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('\x1b[?2004h')

      const snapshot = emulator.getSnapshot()
      expect(snapshot.rehydrateSequences).toContain('\x1b[?2004h')
    })

    it('generates empty rehydration when all modes are default', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('just plain text')

      const snapshot = emulator.getSnapshot()
      expect(snapshot.rehydrateSequences).toBe('')
    })
  })

  describe('absolute cursor tail', () => {
    // Why: SerializeAddon emits a relative cursor-move tail that drifts when
    // the TUI drew rows out of visual order. getSnapshot() appends an
    // absolute `CSI row;col H` after the SerializeAddon output so the
    // restored cursor lands exactly where it was at capture time regardless
    // of what relative math the serializer used.
    it('appends absolute cursor position after the serialized buffer', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('hello\r\nworld')
      // Move cursor to row 10, col 5 (1-indexed CSI)
      await emulator.write('\x1b[10;5H')

      const snapshot = emulator.getSnapshot()
      // Last 6 chars must be the absolute-cursor CSI
      expect(snapshot.snapshotAnsi.endsWith('\x1b[10;5H')).toBe(true)
    })

    it('restores cursor after a normal-buffer TUI that drew rows below the cursor', async () => {
      // Reproduces the shape of the real-world Claude Code bug: input prompt
      // drawn above, border + status drawn below, cursor parked back on the
      // input prompt. SerializeAddon's relative tail would land one row low;
      // the absolute tail corrects it.
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('\x1b[H')
      await emulator.write('\r\n\r\n\r\n\r\n\r\n\r\n') // rows 0-5 blank
      await emulator.write('> ') // row 6 cursor col 2
      await emulator.write('\x1b[8;1H──────') // row 7
      await emulator.write('\x1b[9;1Hstatus') // row 8
      await emulator.write('\x1b[10;1Hhint') // row 9
      await emulator.write('\x1b[7;3H') // park cursor on prompt

      const srcSnapshot = emulator.getSnapshot()

      const replayTerm = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
      await new Promise<void>((resolve) =>
        replayTerm.write(srcSnapshot.rehydrateSequences + srcSnapshot.snapshotAnsi, () => resolve())
      )

      expect(replayTerm.buffer.active.cursorX).toBe(2)
      expect(replayTerm.buffer.active.cursorY).toBe(6)
      replayTerm.dispose()
    })
  })

  describe('dispose', () => {
    it('can be disposed without error', () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      expect(() => emulator.dispose()).not.toThrow()
    })
  })

  // ---------------------------------------------------------------------------
  // Snapshot restore round-trip — alt-screen cursor alignment
  //
  // Regression guard for the "cursor lands one row below the TUI input box
  // after restart" bug. The reattach path in pty-connection.ts writes
  // `rehydrateSequences + snapshotAnsi` into a fresh xterm. For alt-screen
  // sessions, `rehydrateSequences` must not pre-enter the alt buffer with
  // `\x1b[?1049h` because SerializeAddon's own output already emits
  // `\x1b[?1049h\x1b[H` between the normal and alt buffers. Pre-entering
  // causes normal-buffer content to be drawn into the alt buffer, pushing
  // the alt cursor down by the height of the normal buffer's trailing rows.
  // ---------------------------------------------------------------------------
  describe('alt-screen snapshot restore round-trip', () => {
    async function replaySnapshotIntoFreshTerminal(rehydrate: string, snapshotAnsi: string) {
      const replayTerm = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
      await new Promise<void>((resolve) =>
        replayTerm.write(rehydrate + snapshotAnsi, () => resolve())
      )
      return replayTerm
    }

    it('places the cursor at the same (row, col) as the source alt-screen terminal', async () => {
      // Simulate a shell session that ran `$ claude`, entered alt-screen, drew
      // the Claude UI header + an input box, and left the cursor inside the
      // input box at column 2, row 5.
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('$ claude\r\n')
      await emulator.write('\x1b[?1049h\x1b[H') // enter alt screen, home
      await emulator.write('Claude Code v2.1.126\r\n')
      await emulator.write('Opus 4.7 · API Usage Billing\r\n')
      await emulator.write('~/orca/workspaces/orca/Chimaera\r\n')
      await emulator.write('\r\n') // blank
      await emulator.write('> ') // input prompt
      // Cursor is now at row 4, col 2 in the alt buffer.

      const srcSnapshot = emulator.getSnapshot()
      expect(srcSnapshot.modes.alternateScreen).toBe(true)

      // Match the reattach path in daemon-pty-adapter.ts:199 exactly:
      // `snapshotPayload = rehydrateSequences + snapshotAnsi`.
      const replayTerm = await replaySnapshotIntoFreshTerminal(
        srcSnapshot.rehydrateSequences,
        srcSnapshot.snapshotAnsi
      )

      expect(replayTerm.buffer.active.type).toBe('alternate')
      expect(replayTerm.buffer.active.cursorY).toBe(emulator.getSnapshot().rows - 24 + 4)
      // The crucial assertion: cursor col/row match the source.
      expect({
        x: replayTerm.buffer.active.cursorX,
        y: replayTerm.buffer.active.cursorY
      }).toEqual({ x: 2, y: 4 })
      replayTerm.dispose()
    })

    it('places cursor correctly when the normal buffer has scrollback beyond terminal rows', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      // Fill normal buffer with enough scrollback that it scrolls past one screen.
      for (let i = 0; i < 40; i++) {
        await emulator.write(`line ${i}\r\n`)
      }
      await emulator.write('$ claude\r\n')
      await emulator.write('\x1b[?1049h\x1b[H')
      await emulator.write('Claude Code v2.1.126\r\n')
      await emulator.write('Opus 4.7 · API Usage Billing\r\n')
      await emulator.write('~/orca/workspaces/orca/Chimaera\r\n')
      await emulator.write('\r\n')
      await emulator.write('> ')
      const srcSnapshot = emulator.getSnapshot()
      expect(srcSnapshot.modes.alternateScreen).toBe(true)

      const replayTerm = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
      await new Promise<void>((resolve) =>
        replayTerm.write(srcSnapshot.rehydrateSequences + srcSnapshot.snapshotAnsi, () => resolve())
      )

      expect(replayTerm.buffer.active.type).toBe('alternate')
      expect({
        x: replayTerm.buffer.active.cursorX,
        y: replayTerm.buffer.active.cursorY
      }).toEqual({ x: 2, y: 4 })
      replayTerm.dispose()
    })

    it('reproduces the renderer write sequence: local scrollback replay, then daemon snapshot reattach', async () => {
      // Source: same alt-screen Claude session as above.
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('$ claude\r\n')
      await emulator.write('\x1b[?1049h\x1b[H')
      await emulator.write('Claude Code v2.1.126\r\n')
      await emulator.write('Opus 4.7 · API Usage Billing\r\n')
      await emulator.write('~/orca/workspaces/orca/Chimaera\r\n')
      await emulator.write('\r\n')
      await emulator.write('> ')
      const srcSnapshot = emulator.getSnapshot()

      // Step 1: restoreScrollbackBuffers replays the LOCAL saved xterm buffer
      // (same data as the daemon's serialize, since both sides come from the
      // same bytes), followed by POST_REPLAY_MODE_RESET.
      //   Local serialized buffer = `snapshotAnsi` (what the renderer's
      //   SerializeAddon would have produced when Orca saved layout state).
      const POST_REPLAY_MODE_RESET =
        '\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1006l\x1b[?2004l'
      // Step 2: reattach path — pty-connection.ts:587 — clear then write
      // `rehydrateSequences + snapshotAnsi`, then POST_REPLAY_FOCUS_REPORTING_RESET.
      const POST_REPLAY_FOCUS_REPORTING_RESET = '\x1b[?25h\x1b[?1004l'
      const snapshotPayload = srcSnapshot.rehydrateSequences + srcSnapshot.snapshotAnsi

      const replayTerm = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
      await new Promise<void>((resolve) =>
        replayTerm.write(srcSnapshot.snapshotAnsi + POST_REPLAY_MODE_RESET, () => resolve())
      )
      await new Promise<void>((resolve) =>
        replayTerm.write(
          `\x1b[2J\x1b[3J\x1b[H${snapshotPayload}${POST_REPLAY_FOCUS_REPORTING_RESET}`,
          () => resolve()
        )
      )

      expect(replayTerm.buffer.active.type).toBe('alternate')
      expect({
        x: replayTerm.buffer.active.cursorX,
        y: replayTerm.buffer.active.cursorY
      }).toEqual({ x: 2, y: 4 })
      replayTerm.dispose()
    })
  })
})
