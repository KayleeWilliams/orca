// Why: Electron `<webview>` guests render in a separate Chromium process and
// capture pointer events off the host renderer's event loop. During a dnd-kit
// tab drag, that means `pointerup` lands in the guest instead of document, so
// onDragEnd never fires and dropping an editor/terminal tab onto a split over a
// browser tab silently fails (the blue drop overlay shows, then nothing
// happens). Flipping `pointer-events: none` on every registered webview for the
// duration of a drag lets dnd-kit's PointerSensor see the release on the host.
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
  }
}
