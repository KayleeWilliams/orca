# Split Groups PR 1: Model Foundations

This branch lands the behavior-neutral tab-group model groundwork.

Scope:
- add persisted tab-group layout state
- add active-group persistence and hydration
- add group-aware unified-tab helpers in the store
- connect editor/open-file flows to the unified tab-group model

What Is Actually Hooked Up In This PR:
- the store persists `groupsByWorktree`, `layoutByWorktree`, and `activeGroupIdByWorktree`
- workspace session save/hydration includes tab-group layouts
- editor actions create and activate unified tabs through the group model
- the visible workspace renderer is still the legacy single-surface path

What Is Not Hooked Up Yet:
- `Terminal.tsx` does not render split groups
- no split-group UI components are mounted
- no PTY lifecycle changes land here
- no worktree activation fallback changes land here

Non-goals:
- no split-group UI rollout
- no terminal PTY lifecycle changes
- no worktree activation changes
