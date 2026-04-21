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

const registry = new Set<HTMLElement>()

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
