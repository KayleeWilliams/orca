# Terminal Shortcuts

This document is **generated from** `src/renderer/src/components/terminal-pane/terminal-shortcut-table.ts` and is enforced by `terminal-shortcut-table.docs.test.ts`. If the table changes, this file must be regenerated (run the parity test and paste in the expected output).

Notation:
- `Mod` = Cmd on macOS, Ctrl on Windows/Linux
- `Ctrl` / `Meta` / `Alt` / `Shift` are literal modifier keys
- `→ sendInput(X)` means we write bytes X to the PTY
- `→ <action>` means we fire an app-level action

Shortcuts that depend on the Mac "Option as Alt" setting (Option+letter composing vs. Esc+letter emitting) are **not** in this table — they live in `resolveMacOptionAsAltAction` because their matching depends on runtime state.

## Mac (macOS)

| Chord | Action |
| --- | --- |
<!-- BEGIN:MAC -->
| `Mod+Shift+C` | Copy terminal selection |
| `Mod+F` | Toggle terminal search overlay |
| `Mod+K` | Clear active pane screen and scrollback |
| `Mod+W` | Close active split pane (or the tab if only one pane) |
| `Mod+]` | Cycle focus to next split pane |
| `Mod+[` | Cycle focus to previous split pane |
| `Mod+Shift+Enter` | Expand/collapse active split pane to fill the terminal area |
| `Mod+Shift+D` | Split active pane downward (Mac) |
| `Mod+D` | Split active pane to the right (Mac) |
| `Mod+ArrowLeft` | → sendInput(Ctrl+A) — Move cursor to start of line (Ctrl+A) |
| `Mod+ArrowRight` | → sendInput(Ctrl+E) — Move cursor to end of line (Ctrl+E) |
| `Mod+Backspace` | → sendInput(Ctrl+U) — Kill from cursor to start of line (Ctrl+U) |
| `Mod+Delete` | → sendInput(Ctrl+K) — Kill from cursor to end of line (Ctrl+K) |
| `Alt+ArrowLeft` | → sendInput(\eb) — Move cursor backward one word (\eb) |
| `Alt+ArrowRight` | → sendInput(\ef) — Move cursor forward one word (\ef) |
| `Alt+Backspace` | → sendInput(Esc+DEL) — Delete word before cursor (Esc+DEL) |
| `Ctrl+Backspace` | → sendInput(\x17) — Delete word before cursor (unix-word-rubout \x17) |
| `Shift+Enter` | → sendInput(\e[13;2u) — Shift+Enter as CSI-u (\e[13;2u) so agents can distinguish from Enter |
<!-- END:MAC -->

## Windows / Linux

| Chord | Action |
| --- | --- |
<!-- BEGIN:NONMAC -->
| `Mod+Shift+C` | Copy terminal selection |
| `Mod+F` | Toggle terminal search overlay |
| `Mod+K` | Clear active pane screen and scrollback |
| `Mod+W` | Close active split pane (or the tab if only one pane) |
| `Mod+]` | Cycle focus to next split pane |
| `Mod+[` | Cycle focus to previous split pane |
| `Mod+Shift+Enter` | Expand/collapse active split pane to fill the terminal area |
| `Mod+Shift+D` | Split active pane to the right (Linux/Windows) |
| `Alt+Shift+D` | Split active pane downward (Linux/Windows, Windows Terminal convention) |
| `Alt+ArrowLeft` | → sendInput(\eb) — Move cursor backward one word (\eb) |
| `Alt+ArrowRight` | → sendInput(\ef) — Move cursor forward one word (\ef) |
| `Alt+Backspace` | → sendInput(Esc+DEL) — Delete word before cursor (Esc+DEL) |
| `Ctrl+Backspace` | → sendInput(\x17) — Delete word before cursor (unix-word-rubout \x17) |
| `Shift+Enter` | → sendInput(\e[13;2u) — Shift+Enter as CSI-u (\e[13;2u) so agents can distinguish from Enter |
<!-- END:NONMAC -->

## Reserved shell chords (never intercepted)

These fall through to xterm.js and the shell regardless of platform:

- `Ctrl+C` — SIGINT
- `Ctrl+D` — EOF (see #586 — this is why our non-Mac split chord requires Shift)
- `Ctrl+Z` — SIGTSTP
- `Ctrl+\` — SIGQUIT
- `Home` / `End` — start/end of line (xterm's terminfo sequences)
- `Ctrl+R` / `Ctrl+U` / `Ctrl+A` / `Ctrl+E` / `Ctrl+K` / `Ctrl+W` — readline
