// Why: opening a new terminal (Cmd+T, "+" dropdown, split-group "New Terminal",
// or the auto-created first terminal on a freshly activated worktree) must leave
// keyboard focus inside the new xterm, not on the trigger element or <body>. The
// xterm.js instance isn't in the DOM until TerminalPane mounts and openTerminal()
// runs — which happens at least one commit + paint after the createTab() state
// update. Without a deferred focus step, the user has to click into the terminal
// before they can type.
//
// We poll across rAFs (bounded) instead of using a single rAF because:
//   - On Windows the WebGL context construction inside openTerminal can push the
//     helper-textarea attachment past the first frame.
//   - The legacy titlebar TabBar and split-group TabBar both animate and
//     Radix's onCloseAutoFocus can fight us for focus on the same tick.
//
// Falls back to any xterm-helper-textarea on the page so Cmd+T still focuses the
// new tab's terminal even if the [data-terminal-tab-id] node briefly isn't in the
// tree (e.g. during the "legacy → split-group" transition on first mount).
const MAX_FOCUS_ATTEMPTS = 20

export function focusNewTerminalTab(tabId: string): void {
  let attempts = 0
  const tryFocus = (): void => {
    attempts += 1
    const scoped = document.querySelector(
      `[data-terminal-tab-id="${tabId}"] .xterm-helper-textarea`
    ) as HTMLElement | null
    if (scoped) {
      scoped.focus()
      return
    }
    if (attempts >= MAX_FOCUS_ATTEMPTS) {
      const fallback = document.querySelector('.xterm-helper-textarea') as HTMLElement | null
      fallback?.focus()
      return
    }
    requestAnimationFrame(tryFocus)
  }
  requestAnimationFrame(tryFocus)
}
