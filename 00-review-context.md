# Review Context

## Branch Info

- Base: origin/main (merge-base 1daf9d1b94c7449094dc435baeee70a73d0278dd)
- Current: brennanb2025/orca-agent-status-dashboard

## Changed Files Summary

54 files changed (~3245 insertions, ~81 deletions).

### Electron/Main (13 files)
- M src/main/index.ts
- A src/main/agent-hooks/installer-utils.ts
- A src/main/agent-hooks/server.ts
- A src/main/claude/hook-service.ts
- A src/main/codex/hook-service.ts
- A src/main/ipc/agent-hooks.ts
- M src/main/ipc/pty.ts
- M src/main/ipc/pty.test.ts
- M src/main/ipc/register-core-handlers.ts
- M src/main/ipc/register-core-handlers.test.ts
- M src/preload/api-types.d.ts
- M src/preload/index.d.ts
- M src/preload/index.ts

### Frontend Dashboard & Sidebar (19 files)
- M src/renderer/src/App.tsx
- A src/renderer/src/components/dashboard/AgentDashboard.tsx
- A src/renderer/src/components/dashboard/DashboardAgentRow.tsx
- A src/renderer/src/components/dashboard/DashboardFilterBar.tsx
- A src/renderer/src/components/dashboard/DashboardRepoGroup.tsx
- A src/renderer/src/components/dashboard/DashboardWorktreeCard.tsx
- A src/renderer/src/components/dashboard/useDashboardData.ts
- A src/renderer/src/components/dashboard/useDashboardFilter.ts
- A src/renderer/src/components/dashboard/useDashboardKeyboard.ts
- M src/renderer/src/components/right-sidebar/index.tsx
- M src/renderer/src/components/settings/CliSection.tsx
- A src/renderer/src/components/sidebar/AgentStatusHover.tsx
- A src/renderer/src/components/sidebar/AgentStatusHover.test.ts
- M src/renderer/src/components/sidebar/StatusIndicator.tsx
- M src/renderer/src/components/sidebar/WorktreeCard.tsx
- M src/renderer/src/components/sidebar/WorktreeList.tsx
- M src/renderer/src/components/sidebar/smart-sort.ts
- M src/renderer/src/components/sidebar/smart-sort.test.ts
- M src/renderer/src/components/sidebar/visible-worktrees.ts

### Frontend Terminal, Store & Hooks (16 files)
- M src/renderer/src/components/terminal-pane/TerminalPane.tsx
- M src/renderer/src/components/terminal-pane/pty-connection.ts
- M src/renderer/src/components/terminal-pane/pty-dispatcher.ts
- M src/renderer/src/components/terminal-pane/pty-transport.ts
- M src/renderer/src/components/terminal-pane/use-terminal-pane-lifecycle.ts
- M src/renderer/src/hooks/useIpcEvents.ts
- M src/renderer/src/lib/agent-status.ts
- M src/renderer/src/lib/agent-status.test.ts
- M src/renderer/src/store/index.ts
- M src/renderer/src/store/types.ts
- A src/renderer/src/store/slices/agent-status.ts
- A src/renderer/src/store/slices/agent-status.test.ts
- M src/renderer/src/store/slices/editor.ts
- M src/renderer/src/store/slices/store-session-cascades.test.ts
- M src/renderer/src/store/slices/store-test-helpers.ts
- M src/renderer/src/store/slices/tabs.test.ts
- M src/renderer/src/store/slices/terminals.ts

### Utility/Common (5 files)
- M src/cli/index.ts
- M src/cli/runtime-client.ts
- A src/shared/agent-hook-types.ts
- A src/shared/agent-status-types.ts
- A src/shared/agent-status-types.test.ts

## Changed Line Ranges (PR Scope)

<!-- In scope: issues on these lines OR caused by these changes. Out of scope: unrelated pre-existing issues -->

| File | Changed Lines |
|------|---------------|
| src/cli/index.ts | 449-451 |
| src/cli/runtime-client.ts | 386-391 |
| src/main/agent-hooks/installer-utils.ts | 1-68 (all) |
| src/main/agent-hooks/server.ts | 1-202 (all) |
| src/main/claude/hook-service.ts | 1-175 (all) |
| src/main/codex/hook-service.ts | 1-163 (all) |
| src/main/index.ts | 30-32, 114-119, 141-153, 187-187, 194-198, 239-239 |
| src/main/ipc/agent-hooks.ts | 1-19 (all) |
| src/main/ipc/pty.test.ts | ~21, ~39, ~46, ~80-85, ~126, ~144-147, ~291, ~299-306 |
| src/main/ipc/pty.ts | 6-7, 12, 162-166, 184-197 |
| src/main/ipc/register-core-handlers.test.ts | ~18, ~40, ~113-116, ~145, ~176 |
| src/main/ipc/register-core-handlers.ts | 23, 61 |
| src/preload/api-types.d.ts | 63, 358-361 |
| src/preload/index.d.ts | 2, 151-155, 195-207, 213-228 |
| src/preload/index.ts | 7, 420-426, 1284-1309 |
| src/renderer/src/App.tsx | 496-503 |
| src/renderer/src/components/dashboard/AgentDashboard.tsx | 1-147 (all) |
| src/renderer/src/components/dashboard/DashboardAgentRow.tsx | 1-81 (all) |
| src/renderer/src/components/dashboard/DashboardFilterBar.tsx | 1-42 (all) |
| src/renderer/src/components/dashboard/DashboardRepoGroup.tsx | 1-81 (all) |
| src/renderer/src/components/dashboard/DashboardWorktreeCard.tsx | 1-108 (all) |
| src/renderer/src/components/dashboard/useDashboardData.ts | 1-182 (all) |
| src/renderer/src/components/dashboard/useDashboardFilter.ts | 1-87 (all) |
| src/renderer/src/components/dashboard/useDashboardKeyboard.ts | 1-143 (all) |
| src/renderer/src/components/right-sidebar/index.tsx | 2, 22, 115-120, 177 |
| src/renderer/src/components/settings/CliSection.tsx | 1-2, 5, 22, 53-74, 89-90, 126, 128-129, 232, 234, 238-298, 300-324 |
| src/renderer/src/components/sidebar/AgentStatusHover.tsx | 1-350 (all) |
| src/renderer/src/components/sidebar/AgentStatusHover.test.ts | 1-84 (all) |
| src/renderer/src/components/sidebar/StatusIndicator.tsx | 2-4, 13, 18, 27, 43 |
| src/renderer/src/components/sidebar/WorktreeCard.tsx | 10, 12-14, 109-110, 130-176, 295-301 |
| src/renderer/src/components/sidebar/WorktreeList.tsx | 433, 478, 536-544, 551 |
| src/renderer/src/components/sidebar/smart-sort.ts | 1, 4-7, 42-43, 49-102, 107, 167-168, 194-195, 201-202, 237-238, 251-252, 254-262, 284-285, 295-296 |
| src/renderer/src/components/sidebar/smart-sort.test.ts | 5, 56-71, 177-209 |
| src/renderer/src/components/sidebar/visible-worktrees.ts | 124-130, 138-140 |
| src/renderer/src/components/terminal-pane/TerminalPane.tsx | 280-282 |
| src/renderer/src/components/terminal-pane/pty-connection.ts | 44-46, 142-151, 164 |
| src/renderer/src/components/terminal-pane/pty-dispatcher.ts | 207-208 |
| src/renderer/src/components/terminal-pane/pty-transport.ts | 1-4, 23-24, 41-146, 160-161, 168, 247-256, 400-402 |
| src/renderer/src/components/terminal-pane/use-terminal-pane-lifecycle.ts | 318-321 |
| src/renderer/src/hooks/useIpcEvents.ts | 1, 19, 401-433, 437-452 |
| src/renderer/src/lib/agent-status.ts | 2-7, 25-26, 97-176 |
| src/renderer/src/lib/agent-status.test.ts | 11, 251-265 |
| src/renderer/src/store/index.ts | 17, 33-34 |
| src/renderer/src/store/types.ts | 15, 30-31 |
| src/renderer/src/store/slices/agent-status.ts | 1-162 (all) |
| src/renderer/src/store/slices/agent-status.test.ts | 1-57 (all) |
| src/renderer/src/store/slices/editor.ts | 104 |
| src/renderer/src/store/slices/store-session-cascades.test.ts | 101, 118-119 |
| src/renderer/src/store/slices/store-test-helpers.ts | 25, 50-51 |
| src/renderer/src/store/slices/tabs.test.ts | 96, 115-116 |
| src/renderer/src/store/slices/terminals.ts | 341-349, 403-404 |
| src/shared/agent-hook-types.ts | 1-11 (all) |
| src/shared/agent-status-types.ts | 1-125 (all) |
| src/shared/agent-status-types.test.ts | 1-99 (all) |

## Review Standards Reference

- Follow /review-code standards
- Focus on: correctness, security, performance, maintainability
- Priority levels: Critical > High > Medium > Low

## File Categories

See "Changed Files Summary" above. Categories are:
1. Electron/Main (13 files)
2. Frontend Dashboard & Sidebar (19 files)
3. Frontend Terminal, Store & Hooks (17 files)
4. Utility/Common (5 files)

## Skipped Issues (Do Not Re-validate)

<!-- Issues validated but deemed not worth fixing. Do not re-validate these in future iterations. -->
<!-- Format: [file:line-range] | [severity] | [reason skipped] | [issue summary] -->

[Initially empty]

## Iteration State

Current iteration: 2
Last completed phase: Iteration 1 Fix complete, typecheck clean
Files fixed iter 1:
- src/main/agent-hooks/server.ts (C1, C2, M2)
- src/main/ipc/pty.ts (H1)
- src/main/claude/hook-service.ts (H2a)
- src/main/codex/hook-service.ts (H2b)
- src/renderer/src/components/terminal-pane/pty-transport.ts (H3)
- src/renderer/src/hooks/useIpcEvents.ts (H4, M5, M6)
- src/renderer/src/components/terminal-pane/pty-connection.ts (H5)
- src/renderer/src/store/slices/terminals.ts (M1)
- src/preload/index.d.ts (M3)
- src/renderer/src/components/dashboard/useDashboardKeyboard.ts (M4)
- src/renderer/src/components/dashboard/AgentDashboard.tsx (M4 — container ref)

## Validated Fix Manifest (Iteration 1)

### Critical
- C1: src/main/agent-hooks/server.ts:20-23 - readJsonBody missing `return` after reject+destroy; no request timeout.

### High
- H1: src/main/ipc/pty.ts:194 - Hardcoded `:` PATH separator breaks Windows dev.
- H2a: src/main/claude/hook-service.ts:94-98 - getStatus returns `installed` if ANY event has managed command; should require ALL CLAUDE_EVENTS and return `partial` otherwise.
- H2b: src/main/codex/hook-service.ts:83-87 - Same as H2a for CODEX_EVENTS.
- H3: src/renderer/src/components/terminal-pane/pty-transport.ts:107-142 - Unbounded `pending` buffer in OSC processor.
- H4: src/renderer/src/hooks/useIpcEvents.ts:407,424 - Debug console.log leaks payload contents on every event.
- H5: src/renderer/src/components/terminal-pane/pty-connection.ts:162-175 - `onAgentStatus` callback on transport not wired from pty-connection, so OSC 9999 payloads are parsed but never forwarded to store.

### Medium
- M1: src/renderer/src/store/slices/terminals.ts:344-349,404 - Inline agent-status sweep skips epoch bump; call `removeAgentStatusByTabPrefix` instead.
- M2: src/main/agent-hooks/server.ts:121-168 - Startup `once('error', reject)` never removed, no persistent error listener; runtime errors can crash main process.
- M3: src/preload/index.d.ts:208-228 - Api type references undefined types (HooksApi, CacheApi, SessionApi, UpdaterApi, FsApi, GitApi, UIApi, RuntimeApi) and duplicates PreloadApi fields.
- M4: src/renderer/src/components/dashboard/useDashboardKeyboard.ts - Global keydown listener intercepts arrow keys and digits even when focus is in terminal, can break terminal navigation.
- M5: src/renderer/src/hooks/useIpcEvents.ts:440-452 - findTerminalTitleForPaneKey returns tab-level title not pane-level; wrong for split panes.
- M6: src/renderer/src/hooks/useIpcEvents.ts:406-431 - No paneKey validation; orphan status entries persist forever.

### Deferred to next iteration (Medium, non-blocking)
- M7: src/renderer/src/components/sidebar/WorktreeCard.tsx:148-150 - Double Object.values filter.
- M8: src/renderer/src/components/sidebar/AgentStatusHover.tsx:334-338 - `now` useMemo staleness.
- M9: src/renderer/src/components/dashboard/useDashboardData.ts:80-82 - O(W*T*P) per render.
- M10: src/cli/runtime-client.ts:386-391 - ORCA_USER_DATA_PATH no trim/validate.

### Skipped (won't fix)
- L: Dead exports AgentStatusPayload, WellKnownAgentType — they document the wire contract and cost nothing.
- L: `'status'` in isCommandGroup — benign per reviewer; callers consult findCommandSpec first.
- L: normalizeField whitespace collapse scope — matches design intent.
- L: pty-transport dead regex exports (extractAgentStatusOsc, stripAgentStatusOsc) — may be test helpers; low churn. Will revisit in iter 2.
- L: `isExplicitAgentStatusFresh` 3x per entry in smart-sort — trivial, defer.
