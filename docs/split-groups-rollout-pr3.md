# Split Groups PR 3: Worktree Restore Ownership

This branch is reserved for moving worktree activation and restore logic onto
the reconciled tab-group model.

Scope:
- reconcile stale unified tabs before restore
- restore active surfaces from the group model first
- fall back to terminal when a grouped worktree has no renderable surface

Non-goals:
- no split-group UI enablement yet

