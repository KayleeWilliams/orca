# Review Context

## Branch Info

- Base: origin/main
- Current: brennanb2025/external-change-to-file-not-reflecting
- Merge base: 20d1524914b00d2e98afece50ed4b31f8af83366

## Changed Files Summary

| Status | File |
| ------ | ---- |
| M | src/renderer/src/App.tsx |
| M | src/renderer/src/components/editor/EditorPanel.tsx |
| M | src/renderer/src/components/editor/MonacoEditor.tsx |
| M | src/renderer/src/components/editor/RichMarkdownEditor.tsx |
| A | src/renderer/src/components/editor/monaco-content-sync.ts |
| A | src/renderer/src/components/editor/monaco-reveal.ts |
| A | src/renderer/src/components/editor/rich-markdown-cut-handler.ts |
| A | src/renderer/src/components/editor/useLocalImagePick.ts |
| A | src/renderer/src/components/right-sidebar/useFileExplorerWatch.test.ts |
| M | src/renderer/src/components/right-sidebar/useFileExplorerWatch.ts |
| M | src/renderer/src/components/tab-bar/EditorFileTab.tsx |
| A | src/renderer/src/hooks/useEditorExternalWatch.ts |
| M | src/renderer/src/store/slices/editor.ts |

## Changed Line Ranges (PR Scope)

<!-- In scope: issues on these lines OR caused by these changes. Out of scope: unrelated pre-existing issues -->

| File | Changed Lines |
| ---- | ------------- |
| src/renderer/src/App.tsx | 30, 141-147 |
| src/renderer/src/components/editor/EditorPanel.tsx | 374-381 |
| src/renderer/src/components/editor/MonacoEditor.tsx | 18-19, 135-145, 150-156, 247, 254-266 |
| src/renderer/src/components/editor/RichMarkdownEditor.tsx | 8, 25, 120, 179-181, 186-187, 190-191, 229-232, 251, 347-351 |
| src/renderer/src/components/editor/monaco-content-sync.ts | 1-71 (new file) |
| src/renderer/src/components/editor/monaco-reveal.ts | 1-67 (new file) |
| src/renderer/src/components/editor/rich-markdown-cut-handler.ts | 1-110 (new file) |
| src/renderer/src/components/editor/useLocalImagePick.ts | 1-39 (new file) |
| src/renderer/src/components/right-sidebar/useFileExplorerWatch.test.ts | 1-59 (new file) |
| src/renderer/src/components/right-sidebar/useFileExplorerWatch.ts | 6, 28-58, 60, 62-67, 112-118, 235-238, 256, 264-277 |
| src/renderer/src/components/tab-bar/EditorFileTab.tsx | 257, 273-278 |
| src/renderer/src/hooks/useEditorExternalWatch.ts | 1-302 (new file) |
| src/renderer/src/store/slices/editor.ts | 101-106, 177, 904-942 |

## Review Standards Reference

- Follow /review-code standards
- Focus on: correctness, security, performance, maintainability
- Priority levels: Critical > High > Medium > Low

## File Categories

All files belong to **Frontend/UI** (all under `src/renderer/`).

### Frontend/UI

- src/renderer/src/App.tsx
- src/renderer/src/components/editor/EditorPanel.tsx
- src/renderer/src/components/editor/MonacoEditor.tsx
- src/renderer/src/components/editor/RichMarkdownEditor.tsx
- src/renderer/src/components/editor/monaco-content-sync.ts
- src/renderer/src/components/editor/monaco-reveal.ts
- src/renderer/src/components/editor/rich-markdown-cut-handler.ts
- src/renderer/src/components/editor/useLocalImagePick.ts
- src/renderer/src/components/right-sidebar/useFileExplorerWatch.test.ts
- src/renderer/src/components/right-sidebar/useFileExplorerWatch.ts
- src/renderer/src/components/tab-bar/EditorFileTab.tsx
- src/renderer/src/hooks/useEditorExternalWatch.ts
- src/renderer/src/store/slices/editor.ts

## Skipped Issues (Do Not Re-validate)

<!-- Issues validated but deemed not worth fixing. Do not re-validate these in future iterations. -->
<!-- Format: [file:line-range] | [severity] | [reason skipped] | [issue summary] -->
<!-- NOTE: Skips should be RARE - only purely cosmetic issues with no functional impact -->

[Initially empty - populated during validation phase]

## Iteration State

<!-- Updated after each phase to enable crash recovery -->

Current iteration: 1
Last completed phase: Setup
Files fixed this iteration: []
