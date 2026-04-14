import type { PaneManager } from '@/lib/pane-manager/pane-manager'

export function fitPanes(manager: PaneManager): void {
  for (const pane of manager.getPanes()) {
    try {
      // Why: fitAddon.fit() triggers a terminal reflow that can leave the viewport
      // at a stale scroll offset, making the terminal appear scrolled up after a
      // resize. Capture whether the terminal was at the bottom before fitting and
      // restore that position afterwards so the user's prompt stays visible.
      const buf = pane.terminal.buffer.active
      const wasAtBottom = buf.viewportY >= buf.baseY
      pane.fitAddon.fit()
      if (wasAtBottom) {
        pane.terminal.scrollToBottom()
      }
    } catch {
      /* ignore */
    }
  }
}

export function focusActivePane(manager: PaneManager): void {
  const panes = manager.getPanes()
  const activePane = manager.getActivePane() ?? panes[0]
  activePane?.terminal.focus()
}

export function fitAndFocusPanes(manager: PaneManager): void {
  fitPanes(manager)
  focusActivePane(manager)
}

export function isWindowsUserAgent(
  userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent
): boolean {
  return userAgent.includes('Windows')
}

export function shellEscapePath(
  path: string,
  userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent
): string {
  if (isWindowsUserAgent(userAgent)) {
    return /^[a-zA-Z0-9_./@:\\-]+$/.test(path) ? path : `"${path}"`
  }

  if (/^[a-zA-Z0-9_./@:-]+$/.test(path)) {
    return path
  }

  return `'${path.replace(/'/g, "'\\''")}'`
}
