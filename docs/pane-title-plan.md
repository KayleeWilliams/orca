# Terminal Pane Custom Title

## Summary

Add the ability to set a custom title on individual terminal **panes** (not tabs — tabs already support `customTitle`). The title displays as a small label bar at the top of the pane. Users set it via the existing right-click context menu.

---

## Current State

- **Tabs** already have `customTitle` (set via tab right-click > "Change Title"), stored on `TerminalTab` and persisted in session state.
- **Panes** (splits within a tab) have no title concept. They are identified internally by numeric `id` and serialized as `leafId` strings (`"pane:3"`).
- The pane context menu (`TerminalContextMenu.tsx`) offers Copy, Paste, Split, Expand, Close, Clear.
- Pane layout is serialized to `TerminalLayoutSnapshot` which has `root` (tree), `activeLeafId`, `expandedLeafId`, and `buffersByLeafId`.

## Design

### Data Model

Add `titlesByLeafId` to the existing `TerminalLayoutSnapshot` type in `src/shared/types.ts`:

```ts
export type TerminalLayoutSnapshot = {
  root: TerminalPaneLayoutNode | null
  activeLeafId: string | null
  expandedLeafId: string | null
  buffersByLeafId?: Record<string, string>
  titlesByLeafId?: Record<string, string> // <-- new
}
```

This keeps pane titles alongside pane buffers in the same serialization path — no new IPC channels, no new store fields. Titles persist across restarts via the existing `session:set` flow.

### State at Runtime

Manage pane titles with a `Record<number, string>` (paneId → title) held in `TerminalPane.tsx` via `useState`. This is local to the tab's terminal pane component, not global Zustand state, because:

- Pane IDs are ephemeral (reset each mount) — Zustand keying would be awkward.
- Titles are already persisted via `TerminalLayoutSnapshot` serialization, which the component already owns.
- No other component needs to read individual pane titles.

```ts
const [paneTitles, setPaneTitles] = useState<Record<number, string>>({})
```

On layout restore (`replayTerminalLayout`), seed `paneTitles` from the snapshot's `titlesByLeafId` using the `paneByLeafId` mapping that `replayTerminalLayout` already returns.

On layout serialize (`serializeTerminalLayout` / `persistLayoutSnapshot`), write `paneTitles` back into `titlesByLeafId`.

**Important: `persistLayoutSnapshot` must preserve titles on layout-only persists.** Every split, resize, expand, and reorder operation calls `persistLayoutSnapshot()`, which builds a fresh `TerminalLayoutSnapshot` from `serializeTerminalLayout()` — this snapshot has no `titlesByLeafId`. The function already preserves `buffersByLeafId` by reading it from the existing Zustand state and merging it back, and titles need the same treatment. Without this, any split or resize would silently drop all pane titles from the persisted snapshot.

Convert the current `paneTitles` (React state, keyed by paneId) to `titlesByLeafId` (keyed by leafId) and include it in the snapshot. Using the live React state is more correct than reading the stale Zustand value because React state reflects in-flight title edits that haven't been persisted yet.

```ts
// Inside persistLayoutSnapshot, after the buffersByLeafId merge:
const currentPanes = manager.getPanes()
const titleEntries = currentPanes
  .filter((p) => paneTitles[p.id])
  .map((p) => [paneLeafId(p.id), paneTitles[p.id]] as const)
if (titleEntries.length > 0) {
  layout.titlesByLeafId = Object.fromEntries(titleEntries)
}
```

This requires `persistLayoutSnapshot` to close over `paneTitles` (or use a ref). Since `paneTitles` is already component-level state in `TerminalPane.tsx` and `persistLayoutSnapshot` is defined in the same scope, a `paneTitlesRef` pattern (like the existing `expandedPaneIdRef`) keeps the closure fresh.

**Important: shutdown `captureBuffers` must merge titles.** The shutdown path calls `captureBuffers` to build a final snapshot with `buffersByLeafId`. This callback must also merge the current `paneTitles` into `titlesByLeafId` on the snapshot — otherwise the snapshot written at shutdown would overwrite the previously persisted one and silently drop all pane titles.

```ts
// Inside captureBuffers, after building buffersByLeafId:
const titleEntries = panes
  .filter((p) => paneTitlesRef.current[p.id])
  .map((p) => [paneLeafId(p.id), paneTitlesRef.current[p.id]] as const)
setTabLayout(tabId, {
  ...layout,
  buffersByLeafId: buffers,
  ...(titleEntries.length > 0 && { titlesByLeafId: Object.fromEntries(titleEntries) })
})
```

### Context Menu: "Set Title" Action

**File: `TerminalContextMenu.tsx`**

Add a "Set Title" / "Edit Title" menu item between "Expand Pane" and "Close Pane":

```
  Split Right          ⌘D
  Split Down           ⌘⇧D
  Expand Pane          ⌘⇧↩
  ─────────────────────
  Set Title...
  ─────────────────────
  Close Pane
  ─────────────────────
  Clear Screen
```

Use a `Pencil` (or `Tag`) icon from lucide-react. Selecting it opens a dialog.

**File: `use-terminal-pane-context-menu.ts`**

Add `onSetTitle` callback to `TerminalMenuState`. This callback should:

1. Resolve the target pane via `resolveMenuPane()`.
2. Signal the parent (`TerminalPane.tsx`) to open the rename dialog for that pane ID.

### Rename Dialog

Reuse the same `Dialog` + `Input` + `Button` pattern from `SortableTab.tsx` (tab rename). Render the dialog inside `TerminalPane.tsx` (it already renders portals for search and context menu).

State needed:

- `renamingPaneId: number | null` — which pane's dialog is open
- `renameValue: string` — current input value

On submit:

- If trimmed value is non-empty → `setPaneTitles(prev => ({ ...prev, [paneId]: trimmed }))`
- If empty → `setPaneTitles(prev => { const next = { ...prev }; delete next[paneId]; return next })`
- Call `persistLayoutSnapshot()` to save immediately.

On cancel (Escape key or close button):

- Discard the input and close the dialog. Do **not** modify `paneTitles` — the previous title (if any) is preserved. Initialize `renameValue` from the existing title when opening so the user sees the current value and can edit or clear it intentionally.

### Title Bar UI

When a pane has a title, render a small label bar at the top of the `.pane` container, above the `.xterm-container`.

**Approach: React overlay rendered via portal**

In `TerminalPane.tsx`, after the pane manager mounts, iterate over `paneTitles` and render a positioned overlay for each titled pane. The overlay targets the pane's `container` element (available from `managerRef.current.getPanes()`).

```tsx
{
  managerRef.current?.getPanes().map((pane) => {
    const title = paneTitles[pane.id]
    if (!title) return null
    return createPortal(<div className="pane-title-bar">{title}</div>, pane.container)
  })
}
```

**Styling (`main.css`):**

```css
.pane-title-bar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 20px;
  z-index: 5; /* below drag handle (z:10) */
  display: flex;
  align-items: center;
  padding: 0 8px;
  font-size: 11px;
  font-family: inherit;
  color: rgba(255, 255, 255, 0.6);
  background: rgba(24, 24, 27, 0.7);
  border-bottom: 1px solid rgba(63, 63, 70, 0.4);
  pointer-events: none; /* clicks pass through to terminal */
  user-select: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Baseline xterm-container layout — the 4px inset padding that pane-lifecycle.ts
   currently sets as inline styles must move here so that the data-has-title
   override below can take effect (CSS attribute selectors cannot override
   inline styles). */
.xterm-container {
  position: relative;
  width: calc(100% - 4px);
  height: calc(100% - 4px);
  margin-top: 4px;
  margin-left: 4px;
}

/* When a pane has a title, shift the terminal content down to make room.
   The .pane container uses position: relative, so the absolutely-positioned
   title bar occupies the top 20px. Height is reduced by the full 24px
   (20px title bar + 4px padding) to prevent overflow/clipping. */
.pane[data-has-title] .xterm-container {
  margin-top: 24px; /* 20px title bar + 4px padding */
  height: calc(100% - 24px); /* must match margin-top to avoid overflow */
}
```

When a pane has a title, push the `.xterm-container` down and shrink its height to make room. Use a **CSS-driven approach** rather than imperative style mutation: toggle a `data-has-title` attribute on the `.pane` container element, and let CSS handle both the margin shift and the height adjustment. This requires that the baseline `.xterm-container` layout (margin, height, width, position) also be CSS-driven — the inline styles currently set in `pane-lifecycle.ts` must be removed (see "Files to Change" below).

```ts
// In the React effect that manages title overlays:
pane.container.setAttribute('data-has-title', '')
// or when title is removed:
pane.container.removeAttribute('data-has-title')
```

Then call `safeFit()` after the attribute change to reflow the terminal.

> **Why CSS-driven instead of imperative style mutation?** `safeFit()` is also called by PaneManager during split/resize/close operations, and `FitAddon.fit()` calculates terminal dimensions from the container's current size. If a React effect mutates `marginTop` in the same frame as a PaneManager operation, the layout reflow can race — the fit calculation may see stale dimensions. By driving layout from a `data-has-title` attribute + CSS rules, the space allocation is always resolved by the browser's layout engine before any JS reads it, eliminating the race.

### Removing a Title

The "Set Title..." dialog doubles as removal: clearing the input and saving removes the title. Alternatively, the context menu item could show "Set Title..." when no title exists and "Edit Title..." / "Clear Title" when one does. Simplest approach: single "Set Title..." item, empty input = remove.

---

## Files to Change

| File                                                                          | Change                                                                                                                                                                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/shared/types.ts`                                                         | Add `titlesByLeafId?` to `TerminalLayoutSnapshot`                                                                                                                                          |
| `src/renderer/src/components/terminal-pane/TerminalContextMenu.tsx`           | Add "Set Title..." menu item + rename dialog                                                                                                                                               |
| `src/renderer/src/components/terminal-pane/use-terminal-pane-context-menu.ts` | Add `onSetTitle` to `TerminalMenuState`, expose `renamingPaneId`                                                                                                                           |
| `src/renderer/src/components/terminal-pane/TerminalPane.tsx`                  | Add `paneTitles` state, serialize back via `persistLayoutSnapshot` and `captureBuffers`, render title bar portals, render rename dialog, toggle `data-has-title` attribute                 |
| `src/renderer/src/components/terminal-pane/use-terminal-pane-lifecycle.ts`    | Seed `paneTitles` from snapshot on restore (using `paneByLeafId` mapping); clean up title state and dismiss rename dialog in `onPaneClosed`                                                |
| `src/renderer/src/lib/pane-manager/pane-lifecycle.ts`                         | Remove inline `width`, `height`, `marginTop`, `marginLeft`, `position` styles from `.xterm-container` creation — all five move to CSS (see `.xterm-container` baseline rule in `main.css`) |
| `src/renderer/src/assets/main.css`                                            | Add `.pane-title-bar` styles, `.xterm-container` baseline layout rule (replacing inline styles), and `.pane[data-has-title] .xterm-container` override                                     |

## Files NOT Changed

- **Zustand store / `terminals.ts`** — pane titles live in the layout snapshot, not as top-level store fields.
- **`layout-serialization.ts`** — `serializeTerminalLayout` stays pure (DOM-only). Title serialization is handled at the call sites (`persistLayoutSnapshot` and `captureBuffers` in `TerminalPane.tsx`) where `paneTitles` state is in scope. Title restore is handled in `use-terminal-pane-lifecycle.ts` using the `paneByLeafId` map that `replayTerminalLayout` already returns.
- **`pane-manager.ts`** — title bar is rendered by React, not by the imperative pane DOM builder. (`pane-lifecycle.ts` IS changed — its inline styles move to CSS.)
- **IPC / preload** — no new channels; titles piggyback on existing `session:set` serialization.
- **`SortableTab.tsx` / `TabBar.tsx`** — tab rename is unrelated to pane titles.

## Edge Cases

- **Pane closed** — title removed from `paneTitles` state when `onPaneClosed` fires. Already cleaned up from serialization since the leaf disappears from the tree.
- **Pane split** — new pane starts with no title. The original pane keeps its title.
- **Pane drag-reorder** — titles follow the pane because they're keyed by `pane.id`, not DOM position.
- **Single pane** — title still shows if set. No special-casing needed.
- **Session restore** — `titlesByLeafId` maps old leaf IDs to titles. `replayTerminalLayout` already returns `paneByLeafId` (old leafId → new paneId), so we can map `titlesByLeafId` → `paneTitles` using the same mapping used for buffer restore.
- **Pane closed while rename dialog is open** — The `onPaneClosed` callback must clear `renamingPaneId` if it matches the closed pane's ID. Otherwise the dialog would submit against a non-existent pane, leaving stale state.
- **Expanded pane with title** — When a pane is expanded, the title bar should remain visible. The expand/collapse logic manipulates `display` and `flex` on `.pane` containers; since the title bar is portaled into the pane container and positioned absolutely within it, it follows the container through expand/collapse without special handling. Verify during implementation that the portal survives the DOM reparenting that expansion may cause.
