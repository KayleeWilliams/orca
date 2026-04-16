# Fix: Legacy fallback renders duplicate TerminalPanes causing PTY race

## The Bug

With the split-group renderer path enabled (#669), there are now **two** code
paths that render terminal surfaces in `Terminal.tsx`:

1. **Split-group path** (`effectiveActiveLayout` is truthy): renders
   `TabGroupSplitLayout` for all mounted worktrees
2. **Legacy fallback** (`!effectiveActiveLayout`): renders `TerminalPane`
   components for all mounted worktrees

The paths are mutually exclusive for the **active** worktree, but the legacy
fallback previously iterated over **all** mounted worktrees — including ones
that the split-group tree is already rendering. During the transition window
when a worktree gains its split-group layout, both paths could simultaneously
mount `TerminalPane` for the same tab, causing two React trees to race over
one PTY:

- Double `connectPanePty()` calls for the same PTY ID
- Unpredictable which instance "wins" the PTY attachment
- The loser gets a detached or stale transport

## The Fix

Narrow the legacy fallback to render **only the active worktree** instead of
all mounted worktrees. Since the split-group path already handles all worktrees
that have layouts, the legacy path only needs to cover the active worktree
during the brief window before its layout is established.

This also simplifies the code: the `allWorktrees.filter().map()` loop becomes
a single conditional render of `activeWorktree`.

## Reproduction

This is a race condition, so it's not deterministically reproducible via user
interaction. It manifests as:

- Terminals that stop receiving output after a worktree switch
- PTY "already attached" errors in the console
- Split panes that appear blank until the tab is closed and reopened

The most reliable trigger is rapidly switching between worktrees while one is
in the process of gaining its split-group layout (e.g., right after creation).

## Would E2E tests fail without this?

**Unlikely to cause deterministic failures**, but it could cause **flaky**
test results. The race window is small — it only exists during the transition
from legacy to split-group rendering for a given worktree. E2E tests that
switch worktrees (like `terminal pane retains content when switching worktrees
and back`) could intermittently fail if both paths bind to the same PTY
during the switch.

This fix is primarily a **correctness improvement** that eliminates a class of
impossible-to-debug flakiness rather than fixing a specific test assertion.
