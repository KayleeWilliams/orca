// Why: Electron `<webview>` guests render in a separate Chromium process and
// paint in their own GPU compositor layer ABOVE normal DOM regardless of CSS
// z-index. That causes two tab-drag failures that must both be solved together:
//
//   1. Pointer events (pointermove, pointerup) for the drag overlay surface
//      are captured by the guest instead of the host's document, so dnd-kit's
//      PointerSensor never sees the release — onDragEnd does not fire and a
//      drop onto a split over a browser tab silently does nothing.
//   2. The host's `.tab-drop-overlay` element (the blue hitbox rectangle) is
//      painted behind the webview's compositor layer even though its CSS
//      z-index is 9999, so the user sees no drop affordance at all while the
//      cursor is over a browser pane.
//
// Fix both at once while a tab drag is active:
//   - `pointer-events: none` lets the host renderer receive pointermove/up.
//   - `visibility: hidden` takes the guest out of the GPU composite so the
//     DOM overlay paints on top. `visibility` (not `display: none`) preserves
//     layout so the overlay's computed rect still matches the pane body.
//
// Kept in its own module (not inside BrowserPane.tsx) so the drag system in
// useTabDragSplit can call this without pulling in the entire BrowserPane
// component tree.

// Why: Vite HMR reloads this module in isolation, replacing the module-level
// binding with a fresh empty Set while the live `<webview>` elements persist
// (they're registered once from BrowserPane.tsx's "create new webview" branch,
// not on every mount). Stashing the Set on `window` lets the reloaded module
// instance re-adopt the existing registrations so drag passthrough keeps
// working across HMR. Mirrors the DRAG_LISTENER_KEY pattern in BrowserPane.tsx.
const DRAG_PASSTHROUGH_REGISTRY_KEY = '__orcaBrowserWebviewDragPassthroughRegistry'
const registry: Set<HTMLElement> = (() => {
  if (typeof window === 'undefined') {
    // Fall back to a module-local Set in non-DOM contexts (tests, SSR-like
    // codepaths). Behavior matches the pre-HMR-fix implementation there.
    return new Set<HTMLElement>()
  }
  const host = window as Window & { [DRAG_PASSTHROUGH_REGISTRY_KEY]?: Set<HTMLElement> }
  const existing = host[DRAG_PASSTHROUGH_REGISTRY_KEY]
  if (existing) {
    return existing
  }
  const created = new Set<HTMLElement>()
  host[DRAG_PASSTHROUGH_REGISTRY_KEY] = created
  return created
})()

export function registerBrowserWebviewForDragPassthrough(webview: HTMLElement): void {
  registry.add(webview)
}

export function unregisterBrowserWebviewForDragPassthrough(webview: HTMLElement): void {
  registry.delete(webview)
}

export function setBrowserWebviewsDragPassthrough(passthrough: boolean): void {
  for (const webview of registry) {
    webview.style.pointerEvents = passthrough ? 'none' : ''
    // Why: the webview's GPU layer paints over CSS z-index; hiding visibility
    // during the drag lets the blue drop overlay become visible. Restored on
    // drag end. See module-level comment for full rationale.
    webview.style.visibility = passthrough ? 'hidden' : ''
  }
}
