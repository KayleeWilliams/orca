import React, {
  lazy,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type MutableRefObject
} from 'react'
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react'
import type { editor as monacoEditor } from 'monaco-editor'
import { joinPath } from '@/lib/path'
import { detectLanguage } from '@/lib/language-detect'
import { useAppStore } from '@/store'
import { computeEditorFontSize } from '@/lib/editor-font-zoom'
import type { GitDiffResult } from '../../../../shared/types'

const ImageDiffViewer = lazy(() => import('./ImageDiffViewer'))

/**
 * Compute approximate added/removed line counts by matching lines
 * between original and modified content using a multiset approach.
 * Not a true Myers diff, but fast and accurate enough for stat display.
 */
function computeLineStats(
  original: string,
  modified: string,
  status: string
): { added: number; removed: number } | null {
  // Why: for very large files (e.g. package-lock.json), splitting and
  // iterating synchronously in the React render cycle would block the
  // main thread and freeze the UI. Return null to skip stats display.
  if (original.length + modified.length > 500_000) {
    return null
  }
  if (status === 'added') {
    return { added: modified ? modified.split('\n').length : 0, removed: 0 }
  }
  if (status === 'deleted') {
    return { added: 0, removed: original ? original.split('\n').length : 0 }
  }

  const origLines = original.split('\n')
  const modLines = modified.split('\n')

  const origMap = new Map<string, number>()
  for (const line of origLines) {
    origMap.set(line, (origMap.get(line) ?? 0) + 1)
  }

  let matched = 0
  for (const line of modLines) {
    const count = origMap.get(line) ?? 0
    if (count > 0) {
      origMap.set(line, count - 1)
      matched++
    }
  }

  return {
    added: modLines.length - matched,
    removed: origLines.length - matched
  }
}

type DiffSection = {
  key: string
  path: string
  status: string
  area?: 'staged' | 'unstaged' | 'untracked'
  oldPath?: string
  originalContent: string
  modifiedContent: string
  collapsed: boolean
  loading: boolean
  dirty: boolean
  diffResult: GitDiffResult | null
}

export function DiffSectionItem({
  section,
  index,
  isBranchMode,
  sideBySide,
  isDark,
  settings,
  sectionHeight,
  worktreeId,
  worktreeRoot,
  loadSection,
  toggleSection,
  setSectionHeights,
  setSections,
  requestRemeasure,
  modifiedEditorsRef,
  handleSectionSaveRef
}: {
  section: DiffSection
  index: number
  isBranchMode: boolean
  sideBySide: boolean
  isDark: boolean
  settings: { terminalFontSize?: number; terminalFontFamily?: string } | null
  sectionHeight: number | undefined
  worktreeId: string
  /** The worktree root directory — not a file path; used to resolve absolute paths for opening files. */
  worktreeRoot: string
  loadSection: (index: number) => void
  toggleSection: (index: number) => void
  setSectionHeights: React.Dispatch<React.SetStateAction<Record<number, number>>>
  setSections: React.Dispatch<React.SetStateAction<DiffSection[]>>
  /** Notify the virtualizer to re-measure this item after an async height change
   *  (e.g. Monaco collapsing unchanged regions or section collapse toggle). */
  requestRemeasure: (index: number) => void
  modifiedEditorsRef: MutableRefObject<Map<string, monacoEditor.IStandaloneCodeEditor>>
  handleSectionSaveRef: MutableRefObject<(sectionKey: string) => Promise<void>>
}): React.JSX.Element {
  const openFile = useAppStore((s) => s.openFile)
  const editorFontZoomLevel = useAppStore((s) => s.editorFontZoomLevel)
  const language = detectLanguage(section.path)
  const isEditable = section.area === 'unstaged'
  const editorFontSize = computeEditorFontSize(
    settings?.terminalFontSize ?? 13,
    editorFontZoomLevel
  )

  const lineStats = useMemo(
    () =>
      section.loading
        ? null
        : computeLineStats(section.originalContent, section.modifiedContent, section.status),
    [section.loading, section.originalContent, section.modifiedContent, section.status]
  )

  // Why: the virtualizer only renders items near the viewport, so mounting
  // this component is the signal to start fetching diff content — replaces
  // the IntersectionObserver that LazySection previously provided.
  useEffect(() => {
    loadSection(index)
  }, [index, loadSection])

  // Why: when the virtualizer unmounts this section during scroll, capture
  // any unsaved edits so they survive the round-trip through section state
  // and are restored when the user scrolls back.
  const sectionKeyRef = useRef(section.key)
  sectionKeyRef.current = section.key
  const latestModifiedContentRef = useRef(section.modifiedContent)
  latestModifiedContentRef.current = section.modifiedContent
  useEffect(() => {
    const editorsMap = modifiedEditorsRef.current
    return () => {
      const sectionKey = sectionKeyRef.current
      if (editorsMap.has(sectionKey)) {
        const content = latestModifiedContentRef.current
        setSections((prev) =>
          prev.map((candidate) =>
            candidate.key === sectionKey ? { ...candidate, modifiedContent: content } : candidate
          )
        )
        editorsMap.delete(sectionKey)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable refs only; runs on unmount
  }, [])

  // Why: after a collapse toggle the wrapper div changes height; the
  // virtualizer needs to re-measure to reposition items below.
  const prevCollapsed = useRef(section.collapsed)
  useLayoutEffect(() => {
    if (prevCollapsed.current !== section.collapsed) {
      prevCollapsed.current = section.collapsed
      requestRemeasure(index)
    }
  }, [section.collapsed, index, requestRemeasure])

  const handleOpenInEditor = (e: React.MouseEvent): void => {
    e.stopPropagation()
    const absolutePath = joinPath(worktreeRoot, section.path)
    openFile({
      filePath: absolutePath,
      relativePath: section.path,
      worktreeId,
      language,
      mode: 'edit'
    })
  }

  const handleMount: DiffOnMount = (editor, monaco) => {
    const modifiedEditor = editor.getModifiedEditor()

    const updateHeight = (): void => {
      const contentHeight = editor.getModifiedEditor().getContentHeight()
      setSectionHeights((prev) => {
        if (prev[index] === contentHeight) {
          return prev
        }
        return { ...prev, [index]: contentHeight }
      })
      // Why: Monaco may report a new content height asynchronously (e.g. after
      // hideUnchangedRegions collapses folds). The virtualizer uses DOM measurement,
      // so we must tell it to re-read this item's size to keep positions correct.
      requestRemeasure(index)
    }
    modifiedEditor.onDidContentSizeChange(updateHeight)
    updateHeight()

    if (!isEditable) {
      return
    }

    modifiedEditorsRef.current.set(section.key, modifiedEditor)
    modifiedEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
      handleSectionSaveRef.current(section.key)
    )
    modifiedEditor.onDidChangeModelContent(() => {
      const current = modifiedEditor.getValue()
      latestModifiedContentRef.current = current
      setSections((prev) =>
        prev.map((candidate) =>
          candidate.key === section.key
            ? { ...candidate, dirty: current !== candidate.modifiedContent }
            : candidate
        )
      )
    })
  }

  return (
    <>
      <div
        className="sticky top-0 z-10 bg-background flex items-center w-full px-3 py-1.5 text-left text-xs hover:bg-accent transition-colors group cursor-pointer"
        onClick={() => toggleSection(index)}
      >
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          <span
            role="button"
            tabIndex={0}
            className="cursor-copy hover:underline"
            onMouseDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
            }}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              // Why: stop both mouse-down and click on the path affordance so
              // the parent section-toggle row cannot consume the interaction
              // before the Electron clipboard write runs.
              void window.api.ui.writeClipboardText(section.path).catch((err) => {
                console.error('Failed to copy diff path:', err)
              })
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') {
                return
              }
              e.preventDefault()
              e.stopPropagation()
              void window.api.ui.writeClipboardText(section.path).catch((err) => {
                console.error('Failed to copy diff path:', err)
              })
            }}
            title="Copy path"
          >
            {section.path}
          </span>
          {section.dirty && <span className="font-medium ml-1">M</span>}
          {lineStats && (lineStats.added > 0 || lineStats.removed > 0) && (
            <span className="tabular-nums ml-2">
              {lineStats.added > 0 && (
                <span className="text-green-600 dark:text-green-500">+{lineStats.added}</span>
              )}
              {lineStats.added > 0 && lineStats.removed > 0 && <span> </span>}
              {lineStats.removed > 0 && <span className="text-red-500">-{lineStats.removed}</span>}
            </span>
          )}
        </span>
        <div className="flex items-center gap-1 shrink-0 ml-2">
          <button
            className="p-0.5 rounded text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={handleOpenInEditor}
            title="Open in editor"
          >
            <ExternalLink className="size-3.5" />
          </button>
          {section.collapsed ? (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          )}
        </div>
      </div>

      {!section.collapsed && (
        <div
          style={{
            height: sectionHeight
              ? sectionHeight + 19
              : Math.max(
                  60,
                  Math.max(
                    section.originalContent.split('\n').length,
                    section.modifiedContent.split('\n').length
                  ) *
                    19 +
                    19
                )
          }}
        >
          {section.loading ? (
            <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
              Loading...
            </div>
          ) : section.diffResult?.kind === 'binary' ? (
            section.diffResult.isImage ? (
              <ImageDiffViewer
                originalContent={section.diffResult.originalContent}
                modifiedContent={section.diffResult.modifiedContent}
                filePath={section.path}
                mimeType={section.diffResult.mimeType}
                sideBySide={sideBySide}
              />
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center">
                <div className="space-y-2">
                  <div className="text-sm font-medium text-foreground">Binary file changed</div>
                  <div className="text-xs text-muted-foreground">
                    {isBranchMode
                      ? 'Text diff is unavailable for this file in branch compare.'
                      : 'Text diff is unavailable for this file.'}
                  </div>
                </div>
              </div>
            )
          ) : (
            <DiffEditor
              height="100%"
              language={language}
              original={section.originalContent}
              modified={section.modifiedContent}
              theme={isDark ? 'vs-dark' : 'vs'}
              onMount={handleMount}
              options={{
                readOnly: !isEditable,
                originalEditable: false,
                renderSideBySide: sideBySide,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                fontSize: editorFontSize,
                fontFamily: settings?.terminalFontFamily || 'monospace',
                lineNumbers: 'on',
                automaticLayout: true,
                renderOverviewRuler: false,
                scrollbar: { vertical: 'hidden', handleMouseWheel: false },
                hideUnchangedRegions: { enabled: true },
                find: {
                  addExtraSpaceOnTop: false,
                  autoFindInSelection: 'never',
                  seedSearchStringFromSelection: 'never'
                }
              }}
            />
          )}
        </div>
      )}
    </>
  )
}
