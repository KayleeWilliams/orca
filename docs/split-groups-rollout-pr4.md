# Split Groups PR 4: Split-Group UI Scaffolding

This branch adds the split-group UI pieces, but does not mount them in the
main workspace host yet.

Scope:
- add `TabGroupPanel`, `TabGroupSplitLayout`, and `useTabGroupController`
- add split-group actions to tab menus and tab-bar affordances
- add the follow-up design note for the architecture

What Is Actually Hooked Up In This PR:
- the new split-group components compile and exist in the tree
- tab-bar level split-group affordances are present in the component layer

What Is Not Hooked Up Yet:
- `Terminal.tsx` does not mount `TabGroupSplitLayout` in this branch
- users still see the legacy single-surface renderer
- no feature switch exists here because the code path is not wired in yet

Non-goals:
- no rollout to users
- no main-renderer ownership change yet
