import {
  TERMINAL_SHORTCUTS,
  type ChordMatch,
  type Modifier,
  type ShortcutEntry
} from './terminal-shortcut-table'
import type {
  MacOptionAsAlt,
  TerminalShortcutAction,
  TerminalShortcutEvent
} from './terminal-shortcut-policy-types'

export type { MacOptionAsAlt, TerminalShortcutAction, TerminalShortcutEvent }

// Why: macOS composition replaces event.key for punctuation, so we map
// event.code to the unmodified character for Esc+ sequences.
const PUNCTUATION_CODE_MAP: Record<string, string> = {
  Period: '.',
  Comma: ',',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`'
}

function chordMatches(event: TerminalShortcutEvent, match: ChordMatch, isMac: boolean): boolean {
  const required = new Set<Modifier>(match.modifiers)
  // `mod` is the primary app modifier: Meta on Mac, Ctrl elsewhere. Expand it
  // into the platform-specific literal modifier so exclusivity checks below
  // correctly reject events with the wrong modifier.
  if (required.has('mod')) {
    required.delete('mod')
    required.add(isMac ? 'meta' : 'ctrl')
  }

  const has = {
    meta: event.metaKey,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey
  }

  // Every required modifier must be present.
  for (const mod of required) {
    if (mod === 'meta' && !has.meta) {
      return false
    }
    if (mod === 'ctrl' && !has.ctrl) {
      return false
    }
    if (mod === 'alt' && !has.alt) {
      return false
    }
    if (mod === 'shift' && !has.shift) {
      return false
    }
  }

  // No non-required modifier may be present. Keeps Ctrl+Shift+D from matching
  // a rule that only required Ctrl, and protects cross-platform chords from
  // accidentally firing when an extra modifier is held.
  if (has.meta && !required.has('meta')) {
    return false
  }
  if (has.ctrl && !required.has('ctrl')) {
    return false
  }
  if (has.alt && !required.has('alt')) {
    return false
  }
  if (has.shift && !required.has('shift')) {
    return false
  }

  if (match.key !== undefined && event.key !== match.key) {
    return false
  }
  if (match.keyLower !== undefined && event.key.toLowerCase() !== match.keyLower) {
    return false
  }
  if (match.code !== undefined) {
    const codes = typeof match.code === 'string' ? [match.code] : match.code
    if (!event.code || !codes.includes(event.code)) {
      return false
    }
  }

  return true
}

function entryAppliesToPlatform(entry: ShortcutEntry, isMac: boolean): boolean {
  return isMac ? entry.mac : entry.nonMac
}

/**
 * Mac Option-as-Alt compensation. Kept imperative because its matching logic
 * depends on runtime state (the `macOptionAsAlt` setting and which physical
 * Option key is held) and on event.code rather than event.key, which doesn't
 * fit the declarative table's shape.
 *
 * With macOptionIsMeta disabled in xterm (so non-US keyboard layouts can
 * compose characters like @ and €), xterm.js no longer translates Option+letter
 * into Esc+letter automatically. We match on event.code (physical key) because
 * macOS composition replaces event.key with the composed character
 * (e.g. Option+B reports key='∫', not key='b').
 *
 * Modes (mirrors Ghostty):
 *  - 'true':  xterm handles all Option as Meta natively; nothing to do here.
 *  - 'false': compensate only the three most critical readline shortcuts (B/F/D).
 *  - 'left'/'right': the designated Option key acts as full Meta (emit Esc+
 *    for any letter/digit/punctuation); the other Option key composes, with
 *    B/F/D compensated.
 */
function resolveMacOptionAsAltAction(
  event: TerminalShortcutEvent,
  macOptionAsAlt: MacOptionAsAlt,
  optionKeyLocation: number
): TerminalShortcutAction | null {
  if (event.metaKey || event.ctrlKey || !event.altKey || event.shiftKey) {
    return null
  }

  // Why: event.location on a character key reports that key's position (always
  // 0 for standard keys), NOT which modifier is held. The caller must track
  // the Option key's own keydown location and pass it as optionKeyLocation.
  const isLeftOption = optionKeyLocation === 1
  const isRightOption = optionKeyLocation === 2
  const shouldActAsMeta =
    (macOptionAsAlt === 'left' && isLeftOption) || (macOptionAsAlt === 'right' && isRightOption)

  if (shouldActAsMeta) {
    if (event.code?.startsWith('Key') && event.code.length === 4) {
      const letter = event.code.charAt(3).toLowerCase()
      return { type: 'sendInput', data: `\x1b${letter}` }
    }
    if (event.code?.startsWith('Digit') && event.code.length === 6) {
      return { type: 'sendInput', data: `\x1b${event.code.charAt(5)}` }
    }
    const punct = event.code ? PUNCTUATION_CODE_MAP[event.code] : undefined
    if (punct) {
      return { type: 'sendInput', data: `\x1b${punct}` }
    }
  }

  // In 'false', 'left', or 'right' mode, the compose-side Option key still
  // needs the three most critical readline shortcuts patched.
  if (macOptionAsAlt !== 'true' && !shouldActAsMeta) {
    if (event.code === 'KeyB') {
      return { type: 'sendInput', data: '\x1bb' }
    }
    if (event.code === 'KeyF') {
      return { type: 'sendInput', data: '\x1bf' }
    }
    if (event.code === 'KeyD') {
      return { type: 'sendInput', data: '\x1bd' }
    }
  }

  return null
}

export function resolveTerminalShortcutAction(
  event: TerminalShortcutEvent,
  isMac: boolean,
  macOptionAsAlt: MacOptionAsAlt = 'false',
  optionKeyLocation: number = 0
): TerminalShortcutAction | null {
  // Key-repeat events should never fire app actions (split, close, etc.) but
  // ARE allowed to emit PTY bytes (holding Alt+Left to jump back several
  // words). The table's entries cover both kinds, so repeat gating happens in
  // the keyboard handler, not here — except that the original policy applied
  // a repeat guard to most chords. Preserve that behavior: reject repeats for
  // everything except sendInput entries.
  for (const entry of TERMINAL_SHORTCUTS) {
    if (!entryAppliesToPlatform(entry, isMac)) {
      continue
    }
    if (!chordMatches(event, entry.match, isMac)) {
      continue
    }
    if (event.repeat && entry.action.type !== 'sendInput') {
      return null
    }
    return entry.action
  }

  if (isMac) {
    return resolveMacOptionAsAltAction(event, macOptionAsAlt, optionKeyLocation)
  }

  return null
}
