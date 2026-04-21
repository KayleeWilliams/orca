# PR 4 of 4 — Agent Dashboard panel

> Delete this file before pushing the PR. It exists only so reviewers
> (human or agent) can place the change in the context of the larger rollout.

## Position in the rollout

```
main
 └── PR 1 — types + store
      ├── PR 2 — main-process hooks
      └── PR 3 — sidebar indicators + hovercard (this PR reuses its dot/icons)
           └── PR 4 (THIS) — Agent Dashboard panel
```

Base: `brennanb2025/pr3-sidebar-status`. Retarget to `main` as prior PRs
merge. This is a pure-UI feature layered on top of infrastructure from PRs
1–3; no main-process or store changes beyond one retention-hook-call site.

## What this PR adds

### Dashboard surface
- `src/renderer/src/components/dashboard/AgentDashboard.tsx` — the panel
  itself. Lists every worktree with live + retained agents and a search box.
- `src/renderer/src/components/dashboard/DashboardWorktreeCard.tsx` —
  per-worktree card rendering its agent rows.
- `src/renderer/src/components/dashboard/DashboardAgentRow.tsx` — single
  agent row with collapsible history, tool-call affordance, and a
  dismiss-X for retained rows.
- `src/renderer/src/components/dashboard/DashboardFilterBar.tsx` — state
  toggle (All / Working / Blocked / Waiting / Done).

### Hooks (view logic split for testability)
- `useDashboardData.ts` — aggregates live `agentStatusByPaneKey` + tabs +
  worktrees into view rows.
- `useDashboardFilter.ts` — filter + search state and the derived filtered list.
- `useDashboardKeyboard.ts` — keyboard nav (J/K/Enter) scoped to the panel.
- `useRetainedAgents.ts` — drives retention of "done" entries. **Runs at
  App level**, not inside `AgentDashboard`, so the sidebar hovercard from
  PR 3 continues to show retained entries even when the dashboard is closed.

### Mount points
- `src/renderer/src/components/right-sidebar/DashboardBottomPanel.tsx` —
  collapsible dock at the bottom of the right sidebar.
- `src/renderer/src/components/right-sidebar/index.tsx` — includes the panel.
- `src/renderer/src/App.tsx` — mounts retention + adds Cmd/Ctrl+Shift+D
  shortcut that opens the right sidebar.

## Deliberately out of scope

- Dashboard only *displays* state. It doesn't modify or poll agents; all data
  flows through PRs 1–3.
- No standalone window or route — dashboard lives inside the existing right
  sidebar's bottom panel.
- No persistence: retention lives in memory only (by design — agents' done
  state is inherently ephemeral and we don't want to replay stale completions
  on app restart).

## Review focus

- `useRetainedAgents` runs at App level: confirm it doesn't leak listeners
  when React Strict Mode double-invokes and that retention doesn't grow
  unbounded (it should bound to `AGENT_STATE_HISTORY_MAX` per pane).
- Filter + keyboard nav interaction: arrow keys should only move inside the
  dashboard, not steal focus from terminal / editor.
- Cmd/Ctrl+Shift+D behavior — opens the right sidebar but does not toggle
  closed when already open (deliberate — see the inline comment in App.tsx).
- Rerender hygiene under a burst of agent-status events — `useDashboardData`
  is expected to memoize; verify no quadratic cost in the worktree loop.

## How to verify locally

```
pnpm install
pnpm tc
pnpm dev
```
Press Cmd/Ctrl+Shift+D to open the right sidebar. The Agent Dashboard panel
is docked at the bottom. Without PR 2 deployed, seed data via devtools as
described in PR 3's context file to exercise the rows, filter, and
retention behavior.
