# Bold/Non-Bold Worktree Card Unread Indicator

## Goal

Replace the yellow bell glyph on each sidebar workspace card with a
**bold / non-bold** treatment of the card title — matching the visual
language already used by the inline agent activity rows under the
experimental agent-status toggle (`DashboardAgentRow.tsx:262`). Unread
**state** (what flips `worktree.isUnread`, what clears it, where it's
persisted) stays exactly as it is today. The change is purely visual
plus the removal of the now-unused manual toggle paths.

## Why

The amber `FilledBellIcon` on the sidebar card is the only remaining
surface in the sidebar that encodes "needs attention" as a colored
glyph. Agent rows already express the same semantic as a weight change
(`font-semibold text-foreground` vs `font-normal text-muted-foreground`
— see `DashboardAgentRow.tsx:262` and the comment block above it: "one
attention axis, not two"). Extending that rule to the workspace card
collapses the two axes on the sidebar into one, reclaims the left-rail
real estate the bell occupies, and removes a duplicate use of amber —
which also signals CI `pending`, conflict operations, and sparse
checkout on the same card.

This change is deliberately scoped to the **sidebar `WorktreeCard`**.
`FilledBellIcon` also has a caller in `SortableTab.tsx:266` for
tab-bar unread; that surface is **explicitly out of scope** (see
"Out of scope" below) and the helper stays exported.

## Today's behavior (the bell)

- `worktree.isUnread` (a `WorktreeMeta` boolean, persisted) drives a
  bell icon rendered on the **left rail** of `WorktreeCard`, gated by
  the `'unread'` card property:
  - `src/renderer/src/components/sidebar/WorktreeCard.tsx:380–404`
    renders `<FilledBellIcon className="... text-amber-500 ...">` when
    unread, or a ghost `<Bell>` (hover-reveal) when read.
  - Clicking the icon toggles via `handleToggleUnreadQuick`
    (`WorktreeCard.tsx:320–327`) → `updateWorktreeMeta({ isUnread: !… })`.
  - The context menu has a parallel toggle
    (`WorktreeContextMenu.tsx:67–69, 172–175`) that is also going away
    (see "Remove manual toggle paths" below).
- The unread flag is also flipped by activation/ack cascades in
  `src/renderer/src/store/slices/worktrees.ts` (around L372, L407, L480,
  L595, L669) and by the CLI orchestration handler
  (`src/cli/handlers/orchestration.ts:71`). **None of this changes.**
  Activation continues to clear unread automatically, which is the
  dominant way unread becomes read today — and after this change, the
  *only* manual way.
- Property toggle in `SidebarHeader.tsx:29` is `{ id: 'unread', label:
  'Unread indicator' }`. Label may change; the id stays the same for
  settings persistence compatibility.

## Reference: how agent rows do bold/non-bold

`WorktreeCardAgents` derives a per-row `isUnvisited` flag from the ack
map (`WorktreeCardAgents.tsx:151`) and passes it to
`DashboardAgentRow`, which switches classes at
`DashboardAgentRow.tsx:262`:

```
isUnvisited ? 'font-semibold text-foreground' : 'font-normal text-muted-foreground'
```

We apply the same two-class pattern to the workspace card's title row.

> Note: agent-row "unvisited" is derived at render time from an ack map
> keyed on `stateStartedAt`; workspace `isUnread` is a persisted boolean
> on `WorktreeMeta`. We're mirroring the *visual language*, not the
> underlying state model. The two systems remain independent.

## Target behavior

### The rule: bold = unread

**On a read card (`worktree.isUnread === false`), no text in the card
body is rendered at `font-semibold` or heavier.** Bold is reserved as
the unread signal. This applies to:

- The title (`displayName`) — today `font-semibold text-foreground`
  (`WorktreeCard.tsx:430`) → on read cards becomes
  `font-normal text-foreground` (weight only; color stays at
  `text-foreground` to preserve hierarchy against the muted branch
  row below, same reasoning as the repo badge).
- The repo badge label — today `font-semibold text-foreground`
  (`WorktreeCard.tsx:508`) → drops to `font-normal text-foreground`
  on read cards to preserve hierarchy (the repo label must not read
  heavier than the workspace title above it).

Small chrome labels already using `font-medium` (`primary`, `sparse`,
`conflict`, Folder-kind badge) stay as-is — they're visually distinct
from bold title copy and are *not* part of the "bold = unread" signal.

**On an unread card (`worktree.isUnread === true`) and the `'unread'`
card property is enabled:**

- The title renders `font-semibold text-foreground`.
- The repo badge label goes back to `font-semibold text-foreground`
  so the hierarchy stays coherent.
- The yellow bell does **not** render anywhere on the card.

**When the card property `'unread'` is off:**

- The card is always rendered as if read, regardless of the store flag.
  This preserves the existing opt-out — users who previously hid the
  bell via this property retain an equivalent "quiet mode."

### Interactions

- **Activation remains the only way to clear unread manually.** Clicking
  the card activates the workspace, which runs the existing cascade in
  `worktrees.ts` and clears `isUnread`. The title de-bolds as part of
  the next render. This is how ~all read-state transitions already
  happen today; the bell's click target and the context-menu "Mark
  Read / Mark Unread" item were the manual escape hatches, and they
  both go away (see next section).
- No Alt-click, middle-click, or other hidden gesture is introduced.

## Changes

### 1. `WorktreeCard.tsx`

- Delete the unread-button block (lines ~380–404):
  - The `<Tooltip>` + `<button onClick={handleToggleUnreadQuick}>` +
    `FilledBellIcon` / `Bell` tree.
- Delete `handleToggleUnreadQuick` and `unreadTooltip` (lines ~320–329)
  entirely. No replacement surface.
- Delete the `FilledBellIcon` import at `WorktreeCard.tsx:30`.
  `FilledBellIcon` itself stays exported from `WorktreeCardHelpers.tsx`
  because `SortableTab.tsx:266` still uses it.
- Update the left-rail wrapper condition:
  - Current: `{(cardProps.includes('status') || cardProps.includes('unread')) && (…)}`
  - New: `{cardProps.includes('status') && (…)}`
  - The rail's only remaining child is the `StatusIndicator`; if
    `'status'` is off and `'unread'` is on, the rail disappears (status
    dot already doesn't render). That's correct — bold/non-bold needs
    no rail real estate.
- Compute one derived flag near the top of the render body:
  ```ts
  // Why: the 'unread' card property is the user's opt-out. When off,
  // we render as if the workspace is read so bold emphasis never appears,
  // matching the old "hide the bell" behavior exactly.
  const showUnreadEmphasis = cardProps.includes('unread') && worktree.isUnread
  ```
- Apply to the display name (`WorktreeCard.tsx:430`):
  ```tsx
  {/* Why: weight alone carries the unread signal; color stays at
      text-foreground in both states so the title keeps hierarchy
      against the muted branch row below (muting the title as well
      flattened the card — same reasoning as the repo chip below). */}
  <div
    className={cn(
      'text-[12px] truncate leading-tight text-foreground',
      showUnreadEmphasis ? 'font-semibold' : 'font-normal'
    )}
  >
    {worktree.displayName}
  </div>
  ```
- Apply to the repo badge label (`WorktreeCard.tsx:508`):
  ```tsx
  {/* Why: repo label tracks the title's weight. If the title is muted
      (read), this stays non-bold so it doesn't out-weigh the workspace
      identifier above it. If the title is bold (unread), this bolds
      with it so the header row reads as one unit. */}
  <span
    className={cn(
      'text-[10px] truncate max-w-[6rem] leading-none lowercase',
      showUnreadEmphasis
        ? 'font-semibold text-foreground'
        : 'font-normal text-foreground'
    )}
  >
    {repo.displayName}
  </span>
  ```
  - Note: we keep `text-foreground` on the read state (not
    `text-muted-foreground`) because the badge already sits on a tinted
    `bg-accent` chip — muting the label as well would leave it nearly
    invisible. The weight change alone is enough to restore hierarchy.

### 2. Remove manual toggle paths

The bell click and the context-menu toggle were the two ways to flip
unread without activating the workspace. In practice, activation covers
the overwhelming majority of read-state transitions, and neither manual
path is load-bearing. Both go away:

- **`WorktreeCard.tsx`**: `handleToggleUnreadQuick` / `unreadTooltip`
  deleted (see section 1).
- **`WorktreeContextMenu.tsx`**:
  - Delete `handleToggleRead` (lines 67–69).
  - Delete the `DropdownMenuItem` for "Mark Read / Mark Unread"
    (lines 172–175).
  - Remove `Bell` and `BellOff` from the `lucide-react` import at
    lines 13–14; they have no other callers in this file.
  - `updateWorktreeMeta` stays imported — still used by the pin toggle.

`isUnread` continues to be set by terminal BEL and orchestration
handlers and cleared by the activation cascade. The user-facing model
becomes: *unread state is automatic; to clear it, open the workspace.*

### 3. `WorktreeCardHelpers.tsx`

- **No changes.** `FilledBellIcon` stays exported because
  `SortableTab.tsx:266` still uses it for tab-bar unread.
- If a future change aligns tab-bar unread with the sidebar's
  bold-for-unread rule, this helper can be deleted then.

### 4. `SidebarHeader.tsx`

- Relabel the property option:
  `{ id: 'unread', label: 'Bold unread workspaces' }` (or similar
  copy reflecting the new mechanism).
  The `id` must stay `'unread'` so settings persistence and existing
  `cardProps.includes('unread')` checks keep working.
- Tests referencing this property (`persistence.test.ts:571/590/610/629`)
  continue to pass — id is unchanged.

### 5. Tests to update / add

- `src/renderer/src/components/sidebar/WorktreeCard.test.tsx` (if it
  asserts on the bell): replace assertions with class-based checks on
  the title and repo-badge elements. If the file doesn't exist, add
  focused tests:
  - unread + property on → title has `font-semibold text-foreground`,
    repo badge label has `font-semibold text-foreground`.
  - unread + property off → title is `font-normal text-muted-foreground`,
    repo badge label is `font-normal text-foreground`.
  - read + property on → same as the unread + property-off case.
  - No `FilledBellIcon` renders in any of the above states.
- `WorktreeContextMenu` test (if one exists): assert that the
  "Mark Read / Mark Unread" item is gone and that `handleToggleRead`
  is no longer referenced.
- Keep `smart-sort.test.ts` / `visible-worktrees.test.ts` / the
  `isUnread` store tests unchanged — they verify the flag's semantics,
  which are unchanged.

### 6. Accessibility

- The bell's `aria-label` ("Mark as read / Mark as unread") disappears
  along with the button.
- Add a visually-hidden prefix inside the title when unread so screen
  readers still surface the state:
  ```tsx
  {showUnreadEmphasis && <span className="sr-only">Unread: </span>}
  {worktree.displayName}
  ```
  The `sr-only` span is preferred over `aria-label` on the card root —
  the card is a non-interactive `<div>`, and `aria-label` on a bare
  `<div>` with no role is inconsistently announced across screen
  readers. A visible-text prefix in the accessible name is reliable.
- No focusable toggle control exists anymore, so there's no keyboard
  affordance for flipping unread. That's consistent with removing the
  manual toggle paths entirely — if we later decide this regression
  is too sharp, a visible hover-reveal dot is the cleanest place to
  re-add one.

## Interaction-state matrix

| Card state | Title | Repo badge | Bell | Notes |
|---|---|---|---|---|
| unread + property on | `font-semibold text-foreground` | `font-semibold text-foreground` | — | Primary target behavior |
| unread + property off | `font-normal text-foreground` | `font-normal text-foreground` | — | Opt-out active; store flag unchanged |
| read + property on | `font-normal text-foreground` | `font-normal text-foreground` | — | Baseline read |
| read + property off | `font-normal text-foreground` | `font-normal text-foreground` | — | Same as read + property on (no signal to hide) |
| SSH disconnected + unread | bold + `opacity-60` (inherited from card root) | bold + `opacity-60` | — | Dimmed but still bolder than the read cards next to it |
| Deleting + unread | bold + `opacity-50 grayscale` | bold + `opacity-50 grayscale` | — | Deleting takes visual priority; acceptable |

Note: during `isDeleting`, a backdrop-blurred overlay
(`WorktreeCard.tsx:~345`) sits over the card body with a "Deleting…"
chip. The title's bold class is preserved but visually subordinate to
the overlay — the matrix row describes the class state, not the
compositional appearance.

## Acceptance criteria

- [ ] No yellow bell renders anywhere on the sidebar `WorktreeCard` at
      any state. (Tab bar's `SortableTab` bell is unaffected and out of
      scope.)
- [ ] On a read card, no text in the card body renders at
      `font-semibold` or heavier.
- [ ] On an unread card (with the `'unread'` property enabled), the
      title and repo badge label render at
      `font-semibold text-foreground`.
- [ ] Turning off the `'unread'` property returns every card to the
      read visual state regardless of `isUnread`.
- [ ] Activating a worktree still clears unread (existing cascade
      logic in `worktrees.ts` untouched).
- [ ] The "Mark Read / Mark Unread" context-menu item is gone.
- [ ] `handleToggleUnreadQuick` and `handleToggleRead` are deleted.
- [ ] `FilledBellIcon` stays exported (still used by `SortableTab`);
      its import in `WorktreeCard.tsx` is removed.
- [ ] Screen reader announces unread state via an `sr-only` prefix
      inside the title element.

## Out of scope

- **Tab bar (`SortableTab`) unread styling.** `SortableTab.tsx:266`
  still uses `FilledBellIcon`. Aligning the tab bar with the
  bold-for-unread rule is a follow-up; this doc deliberately does not
  touch it. The acceptance criterion above is scoped to the sidebar
  `WorktreeCard` specifically.
- Terminal bell, notifications pane, or any other bell site outside
  the sidebar card.
- Redesigning the unread cascade rules (what sets `isUnread`).
- Reintroducing a manual toggle affordance (hover dot, modifier click,
  keyboard shortcut). If triage-without-activation becomes a real
  user-reported regression, add it in a follow-up — do not ship a
  speculative affordance now.
