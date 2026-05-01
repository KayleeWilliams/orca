import type { ManagedPaneInternal, ScrollState } from './pane-manager-types'
import { restoreScrollState } from './pane-scroll'
import { attachWebgl } from './pane-lifecycle'

function refreshAfterReparent(pane: ManagedPaneInternal): void {
  try {
    pane.terminal.refresh(0, pane.terminal.rows - 1)
  } catch {
    /* ignore — pane may have been disposed */
  }
}

// Why: reparenting a terminal container during split resets the viewport
// scroll position (browser clears scrollTop on DOM move). This schedules a
// two-phase restore: an early double-rAF (~32ms) to minimise the visible
// flash, plus a 200ms authoritative restore that also clears the scroll lock.
//
// When `reattachWebgl` is true, the 200ms timer re-creates the WebGL addon
// that splitPane disposed before wrapInSplit. Waiting 200ms ensures the DOM
// has fully settled — attaching WebGL to a canvas that's mid-reparent can
// silently produce a dead context.
export function scheduleSplitScrollRestore(
  getPaneById: (id: number) => ManagedPaneInternal | undefined,
  paneId: number,
  scrollState: ScrollState,
  isDestroyed: () => boolean,
  reattachWebgl?: boolean
): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (isDestroyed()) {
        return
      }
      const live = getPaneById(paneId)
      if (live?.pendingSplitScrollState) {
        restoreScrollState(live.terminal, scrollState)
        refreshAfterReparent(live)
      }
    })
  })

  setTimeout(() => {
    if (isDestroyed()) {
      return
    }
    const live = getPaneById(paneId)
    if (!live) {
      return
    }
    live.pendingSplitScrollState = null
    restoreScrollState(live.terminal, scrollState)

    // Why: splitPane() disposed WebGL before wrapInSplit to prevent Chromium
    // from silently invalidating the context during the DOM reparent. Now that
    // layout has settled, re-attach a fresh WebGL addon so the pane returns to
    // GPU rendering. The refresh after attachment paints the buffer content
    // that accumulated while the pane was on the DOM fallback renderer.
    if (reattachWebgl && live.gpuRenderingEnabled && !live.webglDisabledAfterContextLoss) {
      attachWebgl(live)
    }

    refreshAfterReparent(live)
  }, 200)
}
