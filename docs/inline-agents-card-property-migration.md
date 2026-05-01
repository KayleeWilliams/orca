# Inline-Agents Card-Property Migration

## Context

The "Detailed agent activity" experience is gated by two settings that
evolved separately:

1. `experimentalAgentDashboard` (global setting, persisted in `settings`)
   — the opt-in kill switch. When off, no inline-agent code paths run;
   the sidebar never reads the agent status slice and the view-options
   menu hides the `'inline-agents'` checkbox entirely.

2. `worktreeCardProperties` (persisted UI array) — the user's per-card
   view mode. `'inline-agents'` is one entry in this array. Unchecking
   it hides the inline list even when the experimental toggle is on.

These landed in different releases:

- **Earlier rc**: `experimentalAgentDashboard` shipped as a toggle
  driving a bottom-panel Agent Dashboard. `worktreeCardProperties` at
  that time had no `'inline-agents'` entry because inline agents did
  not exist.
- **Later rc** (commit c1620496, "replace bottom-panel dashboard with
  inline per-card agents list"): the bottom panel was removed. The
  feature migrated into per-workspace-card inline lists, and
  `'inline-agents'` was added to `DEFAULT_WORKTREE_CARD_PROPERTIES`.

## The bug

Coworkers who upgraded to the latest rc — all of whom had
`experimentalAgentDashboard: true` set in the previous rc — reported
that the inline agent activity was not showing up. Investigation
showed the `'inline-agents'` checkbox in the Workspaces view-options
menu was unchecked for every one of them.

Root cause is in `src/main/persistence.ts`'s `load()` path. For fields
whose shape is "full array of user-selected entries", the merge rule
is:

```ts
worktreeCardProperties: parsed.ui?.worktreeCardProperties ?? [...DEFAULT]
```

The persisted array wins wholesale over the new default. This is the
right rule for user-editable lists — otherwise anything a user
deliberately unchecks in one release would re-appear in the next
whenever the default changes — but it means **adding a new entry to
the default array has no effect on users who already have the array
persisted**. Every upgrading user had this array persisted (it's
written on first launch), so the new `'inline-agents'` entry never
reached them.

For toggle-*off* users the bug is invisible: the view-options checkbox
is hidden by `SidebarHeader.tsx:64-67` (`liveAgentsEnabled` gates the
entry out of `visiblePropertyOptions`), and `WorktreeCard.tsx:539`
doesn't render the inline list either way. For toggle-*on* users the
bug is the reported symptom: the feature is enabled globally but
visually absent, with no obvious hint that a second checkbox exists
to unblock it.

## Fix

Two complementary pieces. They cover disjoint populations: existing
opt-ins (migration) and future opt-ins (UI handler).

### 1. One-shot persistence migration (existing opt-ins)

In `src/main/persistence.ts` `load()`, when loading a file:

- If `experimentalAgentDashboard === true` AND the persisted
  `worktreeCardProperties` array exists and does not include
  `'inline-agents'` AND the migration flag
  `_inlineAgentsDefaultedForExperiment` is absent:
  - Append `'inline-agents'` to the array.
  - Set `_inlineAgentsDefaultedForExperiment: true`.
- Otherwise, leave the array untouched and still set the flag to
  `true` so the migration never re-fires.

The flag is essential. Without it, a user who deliberately unchecks
`'inline-agents'` from the view-options menu would have the entry
re-added on every subsequent launch — the persistence-load path can't
tell "array never had it" from "user removed it".

The migration is scoped to `experimentalAgentDashboard === true` on
purpose: users who never opted into the experimental feature have no
visible symptom, and leaving their persisted array alone keeps the
"user choices stick" invariant honest.

### 2. UI handler (future opt-ins)

In `src/renderer/src/components/settings/ExperimentalPane.tsx`, when
the user flips the toggle ON via the Settings UI:

- Read the current `worktreeCardProperties` from the live Zustand
  store.
- If `'inline-agents'` is not present, call
  `toggleWorktreeCardProperty('inline-agents')` to add it.

This covers the "will click the toggle on" case. Without it, a user
who opts in *after* shipping this change would enable the experiment
but still see an unchecked view-mode checkbox, reproducing exactly
the symptom the migration fixes.

We read from the live store (`useAppStore.getState()`) inside the
handler instead of threading `worktreeCardProperties` through props:
the store is the source of truth, and a stale prop reference after a
recent toggle would be easy to miss.

### Schema

One new optional field on `PersistedUIState`:

```ts
/** One-shot migration flag for the inline-agents view-mode rollout. */
_inlineAgentsDefaultedForExperiment?: boolean
```

This follows the existing `_sortBySmartMigrated` convention in the
same file — an underscore prefix signals "migration bookkeeping, not
a user-facing setting", and the field stays optional so older data
files load cleanly.

## Behavior by user group

| Group | `experimentalAgentDashboard` before upgrade | What happens on upgrade | What they see |
|---|---|---|---|
| A: toggle was ON | `true` | Migration runs: `'inline-agents'` appended; flag set. | Inline agent list renders immediately on next launch. View-options checkbox is checked. Can still uncheck it, and the uncheck sticks. |
| B: toggle was OFF | `false` or undefined | Migration does not run (gated on toggle). Flag is set so the migration never considers them again even if they later turn the toggle on and we ship another fix here. | No visible change. The `'inline-agents'` checkbox remains hidden from the view-options menu. If they later opt in via Settings, the UI handler adds `'inline-agents'` at the moment of opt-in. |
| C: fresh install (any release) | N/A | No data file → defaults used directly → `'inline-agents'` is in the default array. | Works out of the box. |

## Why not a simpler approach?

A few alternatives were considered and rejected:

- **Always merge `DEFAULT_WORKTREE_CARD_PROPERTIES` into persisted
  value.** Would re-add any entry a user deliberately removed in any
  release. Breaks the "user choice sticks" invariant for the whole
  array, not just this one entry.
- **Unconditional migration (ignore the toggle).** Slightly simpler,
  harmless for toggle-off users. Rejected because scoping to
  `experimentalAgentDashboard === true` matches intent — we're fixing
  a regression for users who already opted in, not mutating data for
  users who didn't.
- **Do the migration entirely on the renderer side (in
  `hydratePersistedUI`).** Would also work, but the renderer already
  delegates all schema-evolution logic to `persistence.ts`. Keeping
  it on the main side matches the existing `_sortBySmartMigrated` and
  `terminalMacOptionAsAltMigrated` precedents and makes the write-back
  immediate (main persists the migrated array on the next scheduled
  save, rather than waiting for the renderer to call
  `window.api.ui.set`).

## Tests

`src/main/persistence.test.ts` gains four cases:

1. Adds `'inline-agents'` to persisted cardProps when experimental
   toggle is on.
2. Does not add `'inline-agents'` when the toggle is off, but still
   sets the flag.
3. Respects a deliberate uncheck after the migration flag is already
   set (does not re-add).
4. Does not duplicate when `'inline-agents'` is already present.

## Files touched

- `src/shared/types.ts` — declare
  `_inlineAgentsDefaultedForExperiment?: boolean` on
  `PersistedUIState`.
- `src/main/persistence.ts` — one-shot migration in `load()`.
- `src/renderer/src/components/settings/ExperimentalPane.tsx` —
  on-toggle-on UI handler that adds `'inline-agents'` when absent.
- `src/main/persistence.test.ts` — four new migration tests.
