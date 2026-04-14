# Tab Group Model Follow-Up

## Goal

Move Orca's split tab-group implementation from a store-plus-controller shape to a true model/service boundary that is closer to VS Code's editor-group architecture, without porting VS Code wholesale.

This follow-up is intentionally **not** part of the current PR. The current PR already moved the feature in the right direction by:

- making split ratios persisted model state
- centralizing move/copy/merge group operations in the tabs store
- thinning `TabGroupPanel` into more of a view

The next step is to make tab-group behavior a first-class model instead of a set of store records plus helper/controller logic.

## Why

Split tab groups are no longer just a rendering concern. They now carry:

- layout structure
- persisted split ratios
- active group state
- cross-group move/copy semantics
- close/merge behavior
- mixed content types per group

As this grows, keeping behavior split across Zustand records, controller hooks, and React components will become harder to reason about and easier to regress.

VS Code handles this by making editor groups a first-class model/service. Orca does not need the full VS Code abstraction surface, but it should adopt the same direction:

- model owns behavior
- views render model state
- imperative operations go through one boundary

## Current Gaps

Even after the current PR, these gaps remain:

1. Group activation is still minimal.
   Orca tracks `activeGroupIdByWorktree`, but not true MRU group ordering or activation reasons.

2. Group operations are still store-action centric, not model-object centric.
   The store now owns the mutations, but callers still think in terms of raw IDs and records.

3. There are no group lifecycle events.
   React consumers read state snapshots, but there is no explicit event surface for add/remove/move/merge/activate.

4. Hydration and runtime behavior are still tightly coupled to raw store shape.
   This makes it harder to evolve the model without touching many callers.

5. `TabGroupPanel` is thinner, but still knows too much about worktree/group coordination.

## Target Shape

Introduce a per-worktree tab-group model/controller layer, for example:

- `TabGroupWorkspaceModel`
- `TabGroupModel`
- `TabGroupLayoutModel`

This layer should:

- wrap the normalized store state for a single worktree
- expose typed operations instead of raw state surgery
- centralize MRU group activation
- centralize group lifecycle transitions
- provide derived read models for rendering

React components should consume:

- derived selectors for render state
- a small command surface for mutations

They should not need to understand layout tree mutation details.

## Proposed Responsibilities

### `TabGroupWorkspaceModel`

Owns all tab-group state for one worktree:

- groups
- layout tree
- active group
- MRU group order

Exposes commands like:

- `splitGroup(groupId, direction)`
- `closeGroup(groupId)`
- `mergeGroup(groupId, targetGroupId?)`
- `activateGroup(groupId, reason)`
- `moveTab(tabId, targetGroupId, options?)`
- `copyTab(tabId, targetGroupId, options?)`
- `reorderGroupTabs(groupId, orderedTabIds)`
- `resizeSplit(nodePath, ratio)`

### `TabGroupModel`

Represents one group and exposes:

- `id`
- `tabs`
- `activeTab`
- `tabOrder`
- `isActive`
- `isEmpty`

This can be a thin wrapper over store state rather than a heavy OO abstraction.

### `TabGroupLayoutModel`

Encapsulates layout operations:

- replace leaf with split
- remove leaf and collapse tree
- find sibling group
- update split ratio
- validate layout against live groups

This logic is currently spread across `tabs.ts` helpers and should move into one focused module.

## Migration Plan

### Phase 1: Extract Pure Model Utilities

Create a new module for pure tab-group model operations:

- layout mutation
- group merge/collapse rules
- MRU group bookkeeping
- validation helpers

This phase should not change runtime behavior.

### Phase 2: Add Workspace Model Facade

Introduce a facade over the Zustand store for one worktree:

- input: `worktreeId`
- output: commands + derived state

This can begin as a hook-backed facade, but the logic should live outside React as much as possible.

### Phase 3: Move Components To Render-Only

Reduce `TabGroupPanel` and `TabGroupSplitLayout` to:

- render derived state
- dispatch commands

They should no longer assemble group/tab mutation behavior themselves.

### Phase 4: Add MRU Group Semantics

Track:

- active group
- most recently active group order

Use this for:

- close-group merge target selection
- focus restoration after group removal
- more VS Code-like group activation behavior

### Phase 5: Hydration Boundary Cleanup

Move hydration/restore validation through the model layer so layout and groups are repaired in one place.

## Non-Goals

- Porting VS Code's editor-group implementation directly
- Replacing Zustand
- Introducing a large class hierarchy for its own sake
- Refactoring terminal pane internals as part of the same follow-up

## Risks

1. Terminal/editor/browser tabs currently share the unified tab model.
   Refactors must preserve mixed-content behavior across groups.

2. Hydration and worktree switching depend on current store shape.
   The migration should preserve persisted session compatibility.

3. Closing and merging groups can easily regress active-tab restoration.
   MRU rules need explicit tests.

## Test Plan For Follow-Up

Add focused tests around:

- split + resize + restore
- close empty group
- close non-empty group merges into MRU/sibling target
- move tab between groups
- copy tab between groups
- active group restoration after merge
- hydration repairing invalid layout/group combinations
- worktree switch preserving active group and active tab

## Suggested PR Breakdown

1. `refactor: extract tab group layout model helpers`
2. `refactor: add worktree tab group model facade`
3. `refactor: move tab group components to render-only`
4. `feat: add MRU group activation model`
5. `refactor: route hydration through tab group model`

## Recommendation

Do this as a dedicated follow-up PR sequence, not as an extension of the current PR.

The current PR is already the right stopping point:

- enough model centralization to stabilize the feature
- not so much architectural churn that review and regression risk explode
