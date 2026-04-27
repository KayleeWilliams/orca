# Review Context

## Branch Info

- Base: origin/main (merge-base 8e44541c4c53cfdf6bb149dc7dc4524eff24405a)
- Current: brennanb2025/foreground-process-agent-exit

## Changed Files Summary

- M src/main/agent-foreground-poller.test.ts (new, 170 lines)
- M src/main/agent-foreground-poller.ts (170→200 lines added net)
- M src/main/index.ts
- M src/main/ipc/pty.ts
- M src/preload/api-types.d.ts
- M src/preload/index.d.ts
- M src/preload/index.ts
- M src/renderer/src/hooks/resolve-pane-key-for-pty-id.test.ts (new)
- M src/renderer/src/hooks/useIpcEvents.test.ts
- M src/renderer/src/hooks/useIpcEvents.ts

## Changed Line Ranges (PR Scope)

<!-- In scope: issues on these lines OR caused by these changes. Out of scope: unrelated pre-existing issues -->

| File                                                        | Changed Lines                                    |
| ----------------------------------------------------------- | ------------------------------------------------ |
| src/main/agent-foreground-poller.test.ts                    | 1-170 (entire new file)                          |
| src/main/agent-foreground-poller.ts                         | 1-200 (entire new file)                          |
| src/main/index.ts                                           | 48-49, 187-191, 205-222, 240-270                 |
| src/main/ipc/pty.ts                                         | 77                                               |
| src/preload/api-types.d.ts                                  | 365                                              |
| src/preload/index.d.ts                                      | 86                                               |
| src/preload/index.ts                                        | 335-345                                          |
| src/renderer/src/hooks/resolve-pane-key-for-pty-id.test.ts  | 1-46 (entire new file)                           |
| src/renderer/src/hooks/useIpcEvents.test.ts                 | 144, 324, 497, 683, 858, 1028, 1210              |
| src/renderer/src/hooks/useIpcEvents.ts                      | 667-692, 772-805                                 |
| src/shared/constants.ts                                     | 20                                               |

## Review Standards Reference

- Follow /review-code standards
- Focus on: correctness, security, performance, maintainability
- Priority levels: Critical > High > Medium > Low

## File Categories

### Electron/Main

- src/main/agent-foreground-poller.test.ts
- src/main/agent-foreground-poller.ts
- src/main/index.ts
- src/preload/api-types.d.ts
- src/preload/index.d.ts
- src/preload/index.ts

### Backend/IPC

- src/main/ipc/pty.ts

### Frontend/UI

- src/renderer/src/hooks/resolve-pane-key-for-pty-id.test.ts
- src/renderer/src/hooks/useIpcEvents.test.ts
- src/renderer/src/hooks/useIpcEvents.ts

### Utility/Common

- src/shared/constants.ts

## Skipped Issues (Do Not Re-validate)

- agent-foreground-poller.ts:124-166 | Low | architectural speculation (unbounded concurrency / SSH load) — no practical impact, getForegroundProcess is O(1) in-memory | Promise.all fan-out across tracked panes
- agent-foreground-poller.ts:28 | Low | speculative DRY concern vs LocalPtyProvider.getDefaultShell | SHELL_BASENAMES duplicates getDefaultShell paths
- agent-foreground-poller.ts:30-35 | Low | defensive dead-branch with early-return caller | isShellProcess(null) branch unreachable
- agent-foreground-poller.ts:111-114 | Low | JSDoc polish only | pollOnce re-entry guard silently no-ops concurrent calls
- agent-foreground-poller.ts:156-164 | Low | edge case: re-track same paneKey with same ptyId during in-flight poll could inherit stale lastWasShell | mid-flight observation overwrite
- agent-foreground-poller.test.ts:146-169 | Low | test coverage gap for re-track-with-different-ptyId | missing test case
- useIpcEvents.ts:784 | Medium | architectural churn: move resolvePaneKeyForPtyId to selector module — mirrors existing resolvePaneKey pattern; would be a larger refactor out of scope for this PR | colocation with IPC wiring
- useIpcEvents.ts:788 | Low | O(N tabs * M panes) scan is fine for low-frequency event | linear scan on every foreground-shell
- useIpcEvents.ts:668 | Low | flag-gate coupling is intentional and shared with adjacent agentStatus.onSet listener | dashboard flag gating
- index.ts:250-261 | Low | emitShell isDestroyed() race only possible across microtasks, which setInterval/send do not cross | webContents destroyed between guard and send
- index.ts:267-269 | Low | HMR-only concern with unclear applicability | registerPaneKeyTeardownListener unsubscribe not stored
- index.ts:191 | Low | intentional design: stop() clears tracked map, next agentStatus:set re-registers; 30-min TTL covers gap | tracked map lost across window re-creation
- resolve-pane-key-for-pty-id.test.ts:7-13 | Low | `unknown` cast over partial AppState; test still asserts real behavior | test helper type narrowing

## Iteration State

Current iteration: 1
Last completed phase: Validation
Files fixed this iteration: []
