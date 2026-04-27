# Review Context

## Branch Info

- Base: origin/main (8e44541c4c53cfdf6bb149dc7dc4524eff24405a)
- Current: brennanb2025/fix-session-hydration-data-loss

## Changed Files Summary

- M src/main/persistence.test.ts
- M src/main/persistence.ts
- M src/renderer/src/App.tsx
- M src/renderer/src/lib/workspace-session.test.ts
- M src/renderer/src/lib/workspace-session.ts
- M src/renderer/src/store/slices/terminals-hydration.test.ts
- M src/renderer/src/store/slices/terminals.ts

## Changed Line Ranges (PR Scope)

<!-- In scope: issues on these lines OR caused by these changes. Out of scope: unrelated pre-existing issues -->

| File                                                      | Changed Lines                                          |
| --------------------------------------------------------- | ------------------------------------------------------ |
| src/main/persistence.test.ts                              | 5, 585-712                                             |
| src/main/persistence.ts                                   | 5-14, 57-68, 88-93, 99-154, 269-277, 308-316           |
| src/renderer/src/App.tsx                                  | 31-34, 98, 188-192, 283-296, 316-320, 355, 389, 399-403|
| src/renderer/src/lib/workspace-session.test.ts            | 1-2, 143-243                                           |
| src/renderer/src/lib/workspace-session.ts                 | 11-27                                                  |
| src/renderer/src/store/slices/terminals-hydration.test.ts | 269-309                                                |
| src/renderer/src/store/slices/terminals.ts                | 98-106, 230-233                                        |

## Review Standards Reference

- Follow /review-code standards
- Focus on: correctness, security, performance, maintainability
- Priority levels: Critical > High > Medium > Low

## File Categories

### Electron/Main
- src/main/persistence.ts
- src/main/persistence.test.ts

### Frontend/UI
- src/renderer/src/App.tsx
- src/renderer/src/lib/workspace-session.ts
- src/renderer/src/lib/workspace-session.test.ts
- src/renderer/src/store/slices/terminals.ts
- src/renderer/src/store/slices/terminals-hydration.test.ts

## Skipped Issues (Do Not Re-validate)

<!-- Issues validated but deemed not worth fixing. Do not re-validate these in future iterations. -->
<!-- Format: [file:line-range] | [severity] | [reason skipped] | [issue summary] -->
<!-- NOTE: Skips should be RARE - only purely cosmetic issues with no functional impact -->

[None yet]

## Iteration State

Current iteration: 1
Last completed phase: Setup
Files fixed this iteration: []
