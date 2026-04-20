import { describe, expect, it } from 'vitest'
import {
  resolveTerminalShortcutAction,
  type TerminalShortcutEvent
} from './terminal-shortcut-policy'

function event(overrides: Partial<TerminalShortcutEvent>): TerminalShortcutEvent {
  return {
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...overrides
  }
}

// These cases exercise `resolveMacOptionAsAltAction` — the one branch kept
// imperative because it depends on runtime state (macOptionAsAlt setting +
// which physical Option key is held) and matches on event.code rather than
// event.key (macOS composition replaces event.key with the composed glyph).
describe('mac option-as-alt compensation', () => {
  it('translates macOS Option+B/F/D to readline escape sequences in compose mode', () => {
    // With macOptionAsAlt='false' (compose), xterm.js doesn't translate these.
    // Matches on event.code because macOS composition replaces event.key.
    expect(
      resolveTerminalShortcutAction(event({ key: '∫', code: 'KeyB', altKey: true }), true, 'false')
    ).toEqual({ type: 'sendInput', data: '\x1bb' })
    expect(
      resolveTerminalShortcutAction(event({ key: 'ƒ', code: 'KeyF', altKey: true }), true, 'false')
    ).toEqual({ type: 'sendInput', data: '\x1bf' })
    expect(
      resolveTerminalShortcutAction(event({ key: '∂', code: 'KeyD', altKey: true }), true, 'false')
    ).toEqual({ type: 'sendInput', data: '\x1bd' })

    // On Linux/Windows, Alt+B/F/D must still pass through (the table's Alt+Arrow
    // word-nav rule is specific to ArrowLeft/Right, not letters).
    expect(
      resolveTerminalShortcutAction(event({ key: 'b', code: 'KeyB', altKey: true }), false)
    ).toBeNull()

    // Option+Shift+B/F/D is a different chord (selection/capitalization); do
    // not intercept.
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'B', code: 'KeyB', altKey: true, shiftKey: true }),
        true,
        'false'
      )
    ).toBeNull()
  })

  it('sends Esc+letter for any Option+letter when left Option acts as alt', () => {
    // Left Option (location=1) in 'left' mode: full Meta for any letter key.
    expect(
      resolveTerminalShortcutAction(
        event({ key: '¬', code: 'KeyL', altKey: true }),
        true,
        'left',
        1
      )
    ).toEqual({ type: 'sendInput', data: '\x1bl' })
    expect(
      resolveTerminalShortcutAction(
        event({ key: '†', code: 'KeyT', altKey: true }),
        true,
        'left',
        1
      )
    ).toEqual({ type: 'sendInput', data: '\x1bt' })

    // Right Option (location=2) in 'left' mode is the compose side; only B/F/D
    // still get patched so core readline word-nav works regardless.
    expect(
      resolveTerminalShortcutAction(
        event({ key: '∫', code: 'KeyB', altKey: true }),
        true,
        'left',
        2
      )
    ).toEqual({ type: 'sendInput', data: '\x1bb' })
    // Right Option+L must pass through (its composed glyph).
    expect(
      resolveTerminalShortcutAction(
        event({ key: '¬', code: 'KeyL', altKey: true }),
        true,
        'left',
        2
      )
    ).toBeNull()
  })

  it('sends Esc+letter for any Option+letter when right Option acts as alt', () => {
    // Right Option (location=2) in 'right' mode: full Meta including punctuation.
    expect(
      resolveTerminalShortcutAction(
        event({ key: '≥', code: 'Period', altKey: true }),
        true,
        'right',
        2
      )
    ).toEqual({ type: 'sendInput', data: '\x1b.' })

    expect(
      resolveTerminalShortcutAction(
        event({ key: '¬', code: 'KeyL', altKey: true }),
        true,
        'right',
        2
      )
    ).toEqual({ type: 'sendInput', data: '\x1bl' })

    // Left Option (location=1) in 'right' mode is the compose side.
    expect(
      resolveTerminalShortcutAction(
        event({ key: '¬', code: 'KeyL', altKey: true }),
        true,
        'right',
        1
      )
    ).toBeNull()
  })

  it('does not intercept Option+letter in true mode (xterm handles it natively)', () => {
    expect(
      resolveTerminalShortcutAction(event({ key: 'b', code: 'KeyB', altKey: true }), true, 'true')
    ).toBeNull()
  })
})
