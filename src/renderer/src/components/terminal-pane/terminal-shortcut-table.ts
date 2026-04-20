import type { TerminalShortcutAction } from './terminal-shortcut-policy-types'

/**
 * Declarative table of terminal keyboard shortcuts.
 *
 * Each entry describes a chord (modifiers + key or code) per platform and the
 * action to fire. Platform semantics:
 *  - `mac: true`    → entry applies on macOS (mod = Meta/Cmd)
 *  - `nonMac: true` → entry applies on Windows/Linux (mod = Ctrl)
 *  - both           → platform-agnostic chord
 *
 * Entries are mutually exclusive by construction: `chordMatches` (in
 * terminal-shortcut-policy.ts) rejects any event whose modifier set isn't
 * exactly what the entry requires, so a base chord (e.g. Mod+D) cannot match
 * a Shift-variant event regardless of where it sits in this array. Ordering
 * is not load-bearing for correctness — keep entries grouped by feature for
 * readability only.
 *
 * Chords that require dynamic runtime state (Mac Option-as-Alt composition,
 * which branches on `optionKeyLocation` and the `macOptionAsAlt` setting) are
 * NOT in this table — they live in `resolveMacOptionAsAltAction` because their
 * matching logic is genuinely non-tabular.
 */

/**
 * Modifier tokens:
 *  - `mod`   → Meta on Mac, Ctrl on non-Mac (the "primary app modifier")
 *  - `ctrl`  → literal Ctrl key on both platforms (distinct from mod on Mac)
 *  - `meta`  → literal Meta/Cmd key on both platforms (rarely needed)
 *  - `alt`   → Alt/Option
 *  - `shift` → Shift
 *
 * Any modifier NOT listed on an entry must be ABSENT from the event. This
 * prevents Alt+ArrowLeft from accidentally matching a rule intended for
 * Ctrl+ArrowLeft just because altKey happened to also be true.
 */
export type Modifier = 'mod' | 'ctrl' | 'meta' | 'alt' | 'shift'

export type ChordMatch = {
  modifiers: readonly Modifier[]
  /** Match on event.key (for Arrow/Enter/Backspace/Delete). */
  key?: string
  /** Match on event.key, case-insensitively (letters). */
  keyLower?: string
  /** Match on event.code (physical key) — used for BracketLeft/Right. */
  code?: string | readonly string[]
}

export type ShortcutEntry = {
  id: string
  description: string
  mac: boolean
  nonMac: boolean
  match: ChordMatch
  action: TerminalShortcutAction
}

const MOD = 'mod' as const
const CTRL = 'ctrl' as const
const ALT = 'alt' as const
const SHIFT = 'shift' as const

export const TERMINAL_SHORTCUTS: readonly ShortcutEntry[] = [
  // ===== App actions (Mod = Cmd on Mac, Ctrl elsewhere) =====
  {
    id: 'copy-selection',
    description: 'Copy terminal selection',
    mac: true,
    nonMac: true,
    match: { modifiers: [MOD, SHIFT], keyLower: 'c' },
    action: { type: 'copySelection' }
  },
  {
    id: 'toggle-search',
    description: 'Toggle terminal search overlay',
    mac: true,
    nonMac: true,
    match: { modifiers: [MOD], keyLower: 'f' },
    action: { type: 'toggleSearch' }
  },
  {
    id: 'clear-active-pane',
    description: 'Clear active pane screen and scrollback',
    mac: true,
    nonMac: true,
    match: { modifiers: [MOD], keyLower: 'k' },
    action: { type: 'clearActivePane' }
  },
  {
    id: 'close-active-pane',
    description: 'Close active split pane (or the tab if only one pane)',
    mac: true,
    nonMac: true,
    match: { modifiers: [MOD], keyLower: 'w' },
    action: { type: 'closeActivePane' }
  },
  {
    id: 'focus-next-pane',
    description: 'Cycle focus to next split pane',
    mac: true,
    nonMac: true,
    match: { modifiers: [MOD], code: 'BracketRight' },
    action: { type: 'focusPane', direction: 'next' }
  },
  {
    id: 'focus-previous-pane',
    description: 'Cycle focus to previous split pane',
    mac: true,
    nonMac: true,
    match: { modifiers: [MOD], code: 'BracketLeft' },
    action: { type: 'focusPane', direction: 'previous' }
  },
  {
    id: 'toggle-expand-pane',
    description: 'Expand/collapse active split pane to fill the terminal area',
    mac: true,
    nonMac: true,
    match: { modifiers: [MOD, SHIFT], key: 'Enter', code: ['Enter', 'NumpadEnter'] },
    action: { type: 'toggleExpandActivePane' }
  },

  // ===== Split chords — platform-divergent =====
  // Ctrl+D is EOF on Linux/Win (#586), so non-Mac split requires Shift.
  {
    id: 'split-horizontal-mac',
    description: 'Split active pane downward (Mac)',
    mac: true,
    nonMac: false,
    match: { modifiers: [MOD, SHIFT], keyLower: 'd' },
    action: { type: 'splitActivePane', direction: 'horizontal' }
  },
  {
    id: 'split-vertical-mac',
    description: 'Split active pane to the right (Mac)',
    mac: true,
    nonMac: false,
    match: { modifiers: [MOD], keyLower: 'd' },
    action: { type: 'splitActivePane', direction: 'vertical' }
  },
  {
    id: 'split-vertical-nonmac',
    description: 'Split active pane to the right (Linux/Windows)',
    mac: false,
    nonMac: true,
    match: { modifiers: [MOD, SHIFT], keyLower: 'd' },
    action: { type: 'splitActivePane', direction: 'vertical' }
  },
  {
    id: 'split-horizontal-nonmac',
    description: 'Split active pane downward (Linux/Windows, Windows Terminal convention)',
    mac: false,
    nonMac: true,
    match: { modifiers: [ALT, SHIFT], keyLower: 'd' },
    action: { type: 'splitActivePane', direction: 'horizontal' }
  },

  // ===== PTY byte emits: Mac Cmd+Arrow line navigation =====
  // Cmd+Left/Right → readline Ctrl+A / Ctrl+E (iTerm2/Ghostty convention).
  // xterm.js has no default Cmd+Arrow mapping; without this the chord is dropped.
  {
    id: 'mac-cmd-left-line-start',
    description: 'Move cursor to start of line (Ctrl+A)',
    mac: true,
    nonMac: false,
    match: { modifiers: [MOD], key: 'ArrowLeft' },
    action: { type: 'sendInput', data: '\x01' }
  },
  {
    id: 'mac-cmd-right-line-end',
    description: 'Move cursor to end of line (Ctrl+E)',
    mac: true,
    nonMac: false,
    match: { modifiers: [MOD], key: 'ArrowRight' },
    action: { type: 'sendInput', data: '\x05' }
  },

  // ===== PTY byte emits: Mac Cmd+Backspace/Delete line-kill =====
  {
    id: 'mac-cmd-backspace-kill-line',
    description: 'Kill from cursor to start of line (Ctrl+U)',
    mac: true,
    nonMac: false,
    match: { modifiers: [MOD], key: 'Backspace' },
    action: { type: 'sendInput', data: '\x15' }
  },
  {
    id: 'mac-cmd-delete-kill-to-eol',
    description: 'Kill from cursor to end of line (Ctrl+K)',
    mac: true,
    nonMac: false,
    match: { modifiers: [MOD], key: 'Delete' },
    action: { type: 'sendInput', data: '\x0b' }
  },

  // ===== PTY byte emits: cross-platform word navigation =====
  // Alt+Left/Right → readline backward-word / forward-word. Both platforms
  // produce altKey=true (Option on Mac, Alt on Linux/Win). xterm.js emits
  // \e[1;3D / \e[1;3C by default, which readline doesn't bind to word-nav.
  {
    id: 'alt-left-backward-word',
    description: 'Move cursor backward one word (\\eb)',
    mac: true,
    nonMac: true,
    match: { modifiers: [ALT], key: 'ArrowLeft' },
    action: { type: 'sendInput', data: '\x1bb' }
  },
  {
    id: 'alt-right-forward-word',
    description: 'Move cursor forward one word (\\ef)',
    mac: true,
    nonMac: true,
    match: { modifiers: [ALT], key: 'ArrowRight' },
    action: { type: 'sendInput', data: '\x1bf' }
  },

  // ===== PTY byte emits: word delete =====
  {
    id: 'alt-backspace-backward-kill-word',
    description: 'Delete word before cursor (Esc+DEL)',
    mac: true,
    nonMac: true,
    match: { modifiers: [ALT], key: 'Backspace' },
    action: { type: 'sendInput', data: '\x1b\x7f' }
  },
  {
    id: 'ctrl-backspace-unix-word-rubout',
    description: 'Delete word before cursor (unix-word-rubout \\x17)',
    mac: true,
    nonMac: true,
    // Why: uses literal `ctrl` (not `mod`) so this is Ctrl+Backspace on both
    // platforms. On Mac, Cmd+Backspace is a different chord (kill-line, \x15)
    // handled by the mac-cmd-backspace-kill-line entry above.
    match: { modifiers: [CTRL], key: 'Backspace' },
    action: { type: 'sendInput', data: '\x17' }
  },

  // ===== CSI-u Shift+Enter =====
  {
    id: 'shift-enter-csi-u',
    description: 'Shift+Enter as CSI-u (\\e[13;2u) so agents can distinguish from Enter',
    mac: true,
    nonMac: true,
    match: { modifiers: [SHIFT], key: 'Enter' },
    action: { type: 'sendInput', data: '\x1b[13;2u' }
  }
]
