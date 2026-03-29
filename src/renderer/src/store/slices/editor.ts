/* eslint-disable max-lines */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  GitBranchChangeEntry,
  GitBranchCompareSummary,
  GitStatusEntry,
  SearchResult
} from '../../../../shared/types'

export type DiffSource =
  | 'unstaged'
  | 'staged'
  | 'branch'
  | 'combined-uncommitted'
  | 'combined-branch'

export type BranchCompareSnapshot = Pick<
  GitBranchCompareSummary,
  'baseRef' | 'baseOid' | 'compareRef' | 'headOid' | 'mergeBase'
> & {
  compareVersion: string
}

type CombinedDiffAlternate = {
  source: 'combined-uncommitted' | 'combined-branch'
  branchCompare?: BranchCompareSnapshot
}

export type OpenFile = {
  id: string // use filePath as unique key
  filePath: string // absolute path
  relativePath: string // relative to worktree root
  worktreeId: string
  language: string
  isDirty: boolean
  mode: 'edit' | 'diff'
  diffSource?: DiffSource
  branchCompare?: BranchCompareSnapshot
  branchOldPath?: string
  combinedAlternate?: CombinedDiffAlternate
  combinedAreaFilter?: string // filter combined diff to a specific area (e.g. 'staged', 'unstaged', 'untracked')
  isPreview?: boolean // preview tabs are replaced when another file is single-clicked
}

export type RightSidebarTab = 'explorer' | 'search' | 'source-control' | 'checks'
export type ActivityBarPosition = 'top' | 'side'

export type MarkdownViewMode = 'source' | 'preview'

export type EditorSlice = {
  // Markdown view mode per file (fileId -> mode)
  markdownViewMode: Record<string, MarkdownViewMode>
  setMarkdownViewMode: (fileId: string, mode: MarkdownViewMode) => void

  // Right sidebar
  rightSidebarOpen: boolean
  rightSidebarWidth: number
  rightSidebarTab: RightSidebarTab
  activityBarPosition: ActivityBarPosition
  toggleRightSidebar: () => void
  setRightSidebarOpen: (open: boolean) => void
  setRightSidebarWidth: (width: number) => void
  setRightSidebarTab: (tab: RightSidebarTab) => void
  setActivityBarPosition: (position: ActivityBarPosition) => void

  // File explorer state
  expandedDirs: Record<string, Set<string>> // worktreeId -> set of expanded dir paths
  toggleDir: (worktreeId: string, dirPath: string) => void
  pendingExplorerReveal: {
    worktreeId: string
    filePath: string
    requestId: number
  } | null
  revealInExplorer: (worktreeId: string, filePath: string) => void
  clearPendingExplorerReveal: () => void

  // Open files / editor tabs
  openFiles: OpenFile[]
  activeFileId: string | null
  activeFileIdByWorktree: Record<string, string | null> // worktreeId -> last active file
  activeTabTypeByWorktree: Record<string, 'terminal' | 'editor'> // worktreeId -> last active tab type
  activeTabType: 'terminal' | 'editor'
  setActiveTabType: (type: 'terminal' | 'editor') => void
  openFile: (file: Omit<OpenFile, 'id' | 'isDirty'>, options?: { preview?: boolean }) => void
  pinFile: (fileId: string) => void
  closeFile: (fileId: string) => void
  closeAllFiles: () => void
  setActiveFile: (fileId: string) => void
  reorderFiles: (fileIds: string[]) => void
  markFileDirty: (fileId: string, dirty: boolean) => void
  openDiff: (
    worktreeId: string,
    filePath: string,
    relativePath: string,
    language: string,
    staged: boolean
  ) => void
  openBranchDiff: (
    worktreeId: string,
    worktreePath: string,
    entry: GitBranchChangeEntry,
    compare: GitBranchCompareSummary,
    language: string
  ) => void
  openAllDiffs: (
    worktreeId: string,
    worktreePath: string,
    alternate?: CombinedDiffAlternate,
    areaFilter?: string
  ) => void
  openBranchAllDiffs: (
    worktreeId: string,
    worktreePath: string,
    compare: GitBranchCompareSummary,
    alternate?: CombinedDiffAlternate
  ) => void

  // Cursor line tracking per file
  editorCursorLine: Record<string, number>
  setEditorCursorLine: (fileId: string, line: number) => void

  // Git status cache
  gitStatusByWorktree: Record<string, GitStatusEntry[]>
  setGitStatus: (worktreeId: string, entries: GitStatusEntry[]) => void
  gitBranchChangesByWorktree: Record<string, GitBranchChangeEntry[]>
  gitBranchCompareSummaryByWorktree: Record<string, GitBranchCompareSummary | null>
  gitBranchCompareRequestKeyByWorktree: Record<string, string>
  beginGitBranchCompareRequest: (worktreeId: string, requestKey: string, baseRef: string) => void
  setGitBranchCompareResult: (
    worktreeId: string,
    requestKey: string,
    result: { summary: GitBranchCompareSummary; entries: GitBranchChangeEntry[] }
  ) => void

  // File search state
  fileSearchQuery: string
  fileSearchCaseSensitive: boolean
  fileSearchWholeWord: boolean
  fileSearchUseRegex: boolean
  fileSearchIncludePattern: string
  fileSearchExcludePattern: string
  fileSearchResults: SearchResult | null
  fileSearchLoading: boolean
  fileSearchCollapsedFiles: Set<string>
  setFileSearchQuery: (query: string) => void
  setFileSearchCaseSensitive: (v: boolean) => void
  setFileSearchWholeWord: (v: boolean) => void
  setFileSearchUseRegex: (v: boolean) => void
  setFileSearchIncludePattern: (v: string) => void
  setFileSearchExcludePattern: (v: string) => void
  setFileSearchResults: (results: SearchResult | null) => void
  setFileSearchLoading: (loading: boolean) => void
  toggleFileSearchCollapsedFile: (filePath: string) => void
  clearFileSearch: () => void

  // Editor navigation (for search result → go-to-line)
  pendingEditorReveal: { line: number; column: number; matchLength: number } | null
  setPendingEditorReveal: (
    reveal: { line: number; column: number; matchLength: number } | null
  ) => void

  // Quick open (Cmd+P)
  quickOpenVisible: boolean
  setQuickOpenVisible: (visible: boolean) => void
}

export const createEditorSlice: StateCreator<AppState, [], [], EditorSlice> = (set) => ({
  // Markdown view mode
  markdownViewMode: {},
  setMarkdownViewMode: (fileId, mode) =>
    set((s) => ({
      markdownViewMode: { ...s.markdownViewMode, [fileId]: mode }
    })),

  // Right sidebar
  rightSidebarOpen: false,
  rightSidebarWidth: 280,
  rightSidebarTab: 'explorer',
  activityBarPosition: 'top',
  toggleRightSidebar: () => set((s) => ({ rightSidebarOpen: !s.rightSidebarOpen })),
  setRightSidebarOpen: (open) => set({ rightSidebarOpen: open }),
  setRightSidebarWidth: (width) => set({ rightSidebarWidth: width }),
  setRightSidebarTab: (tab) => set({ rightSidebarTab: tab }),
  setActivityBarPosition: (position) => set({ activityBarPosition: position }),

  // File explorer
  expandedDirs: {},
  toggleDir: (worktreeId, dirPath) =>
    set((s) => {
      const current = s.expandedDirs[worktreeId] ?? new Set<string>()
      const next = new Set(current)
      if (next.has(dirPath)) {
        next.delete(dirPath)
      } else {
        next.add(dirPath)
      }
      return { expandedDirs: { ...s.expandedDirs, [worktreeId]: next } }
    }),
  pendingExplorerReveal: null,
  revealInExplorer: (worktreeId, filePath) =>
    set({
      rightSidebarOpen: true,
      rightSidebarTab: 'explorer',
      pendingExplorerReveal: { worktreeId, filePath, requestId: Date.now() }
    }),
  clearPendingExplorerReveal: () => set({ pendingExplorerReveal: null }),

  // Open files
  openFiles: [],
  activeFileId: null,
  activeFileIdByWorktree: {},
  activeTabTypeByWorktree: {},
  activeTabType: 'terminal',
  setActiveTabType: (type) =>
    set((s) => {
      const worktreeId = s.activeWorktreeId
      return {
        activeTabType: type,
        activeTabTypeByWorktree: worktreeId
          ? { ...s.activeTabTypeByWorktree, [worktreeId]: type }
          : s.activeTabTypeByWorktree
      }
    }),

  openFile: (file, options) =>
    set((s) => {
      const id = file.filePath
      const existing = s.openFiles.find((f) => f.id === id)
      const worktreeId = file.worktreeId
      const isPreview = options?.preview ?? false

      const activeResult = {
        activeFileId: id,
        activeTabType: 'editor' as const,
        activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
        activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' as const }
      }

      if (existing) {
        // If opening as non-preview, also pin the existing tab
        const updatedPreview = isPreview ? existing.isPreview : false
        if (
          existing.mode === file.mode &&
          existing.diffSource === file.diffSource &&
          existing.branchCompare?.compareVersion === file.branchCompare?.compareVersion &&
          existing.isPreview === updatedPreview
        ) {
          return activeResult
        }
        return {
          openFiles: s.openFiles.map((f) =>
            f.id === id
              ? {
                  ...f,
                  mode: file.mode,
                  diffSource: file.diffSource,
                  branchCompare: file.branchCompare,
                  branchOldPath: file.branchOldPath,
                  combinedAlternate: file.combinedAlternate,
                  isPreview: updatedPreview
                }
              : f
          ),
          ...activeResult
        }
      }

      // If opening as preview, replace the existing preview tab for this worktree
      let newFiles = s.openFiles
      if (isPreview) {
        const existingPreviewIdx = s.openFiles.findIndex(
          (f) => f.worktreeId === worktreeId && f.isPreview
        )
        if (existingPreviewIdx !== -1) {
          const replacedPreview = s.openFiles[existingPreviewIdx]
          const nextMarkdownViewMode =
            replacedPreview.id === id
              ? s.markdownViewMode
              : Object.fromEntries(
                  Object.entries(s.markdownViewMode).filter(
                    ([fileId]) => fileId !== replacedPreview.id
                  )
                )
          // Replace in-place to preserve tab position
          newFiles = s.openFiles.map((f, i) =>
            i === existingPreviewIdx ? { ...file, id, isDirty: false, isPreview: true } : f
          )
          return {
            openFiles: newFiles,
            markdownViewMode: nextMarkdownViewMode,
            ...activeResult
          }
        }
      }

      return {
        openFiles: [
          ...newFiles,
          { ...file, id, isDirty: false, isPreview: isPreview || undefined }
        ],
        ...activeResult
      }
    }),

  pinFile: (fileId) =>
    set((s) => {
      const file = s.openFiles.find((f) => f.id === fileId)
      if (!file?.isPreview) {
        return s
      }
      return {
        openFiles: s.openFiles.map((f) => (f.id === fileId ? { ...f, isPreview: undefined } : f))
      }
    }),

  closeFile: (fileId) =>
    set((s) => {
      const closedFile = s.openFiles.find((f) => f.id === fileId)
      const idx = s.openFiles.findIndex((f) => f.id === fileId)
      const newFiles = s.openFiles.filter((f) => f.id !== fileId)
      const newMarkdownViewMode = { ...s.markdownViewMode }
      delete newMarkdownViewMode[fileId]
      let newActiveId = s.activeFileId
      const newActiveFileIdByWorktree = { ...s.activeFileIdByWorktree }

      if (s.activeFileId === fileId) {
        // Find next file within the same worktree
        const worktreeId = closedFile?.worktreeId
        const worktreeFiles = worktreeId
          ? newFiles.filter((f) => f.worktreeId === worktreeId)
          : newFiles
        if (worktreeFiles.length === 0) {
          newActiveId = null
        } else {
          // Pick adjacent file from same worktree
          const closedWorktreeIdx = worktreeId
            ? s.openFiles
                .filter((f) => f.worktreeId === worktreeId)
                .findIndex((f) => f.id === fileId)
            : idx
          newActiveId =
            closedWorktreeIdx >= worktreeFiles.length
              ? worktreeFiles.at(-1)!.id
              : worktreeFiles[closedWorktreeIdx].id
        }
        if (worktreeId) {
          newActiveFileIdByWorktree[worktreeId] = newActiveId
        }
      }

      // When last editor file for current worktree is closed, switch back to terminal
      const activeWorktreeId = s.activeWorktreeId
      const remainingForWorktree = activeWorktreeId
        ? newFiles.filter((f) => f.worktreeId === activeWorktreeId)
        : newFiles
      const newActiveTabType = remainingForWorktree.length === 0 ? 'terminal' : s.activeTabType
      const newActiveTabTypeByWorktree = { ...s.activeTabTypeByWorktree }
      if (activeWorktreeId && remainingForWorktree.length === 0) {
        newActiveTabTypeByWorktree[activeWorktreeId] = 'terminal'
      }

      return {
        openFiles: newFiles,
        activeFileId: newActiveId,
        activeTabType: newActiveTabType,
        activeFileIdByWorktree: newActiveFileIdByWorktree,
        activeTabTypeByWorktree: newActiveTabTypeByWorktree,
        markdownViewMode: newMarkdownViewMode,
        pendingEditorReveal: null
      }
    }),

  closeAllFiles: () =>
    set((s) => {
      const activeWorktreeId = s.activeWorktreeId
      if (!activeWorktreeId) {
        return {
          openFiles: [],
          activeFileId: null,
          activeTabType: 'terminal',
          markdownViewMode: {}
        }
      }
      // Only close files for the current worktree
      const newFiles = s.openFiles.filter((f) => f.worktreeId !== activeWorktreeId)
      const remainingFileIds = new Set(newFiles.map((f) => f.id))
      const newMarkdownViewMode = Object.fromEntries(
        Object.entries(s.markdownViewMode).filter(([fileId]) => remainingFileIds.has(fileId))
      )
      const newActiveFileIdByWorktree = { ...s.activeFileIdByWorktree }
      delete newActiveFileIdByWorktree[activeWorktreeId]
      const newActiveTabTypeByWorktree = { ...s.activeTabTypeByWorktree }
      newActiveTabTypeByWorktree[activeWorktreeId] = 'terminal'
      return {
        openFiles: newFiles,
        activeFileId: null,
        activeTabType: 'terminal',
        markdownViewMode: newMarkdownViewMode,
        activeFileIdByWorktree: newActiveFileIdByWorktree,
        activeTabTypeByWorktree: newActiveTabTypeByWorktree
      }
    }),

  setActiveFile: (fileId) =>
    set((s) => {
      const file = s.openFiles.find((f) => f.id === fileId)
      const worktreeId = file?.worktreeId
      return {
        activeFileId: fileId,
        activeFileIdByWorktree: worktreeId
          ? { ...s.activeFileIdByWorktree, [worktreeId]: fileId }
          : s.activeFileIdByWorktree
      }
    }),

  reorderFiles: (fileIds) =>
    set((s) => {
      const reorderedSet = new Set(fileIds)
      const byId = new Map(s.openFiles.map((f) => [f.id, f]))
      const reordered = fileIds.map((id) => byId.get(id)).filter(Boolean) as OpenFile[]
      // Replace the reordered subset in-place: keep other-worktree files at their positions
      const result: OpenFile[] = []
      let ri = 0
      for (const f of s.openFiles) {
        if (reorderedSet.has(f.id)) {
          result.push(reordered[ri++])
        } else {
          result.push(f)
        }
      }
      return { openFiles: result }
    }),

  markFileDirty: (fileId, dirty) =>
    set((s) => ({
      openFiles: s.openFiles.map((f) =>
        f.id === fileId
          ? { ...f, isDirty: dirty, ...(dirty && f.isPreview ? { isPreview: undefined } : {}) }
          : f
      )
    })),

  openDiff: (worktreeId, filePath, relativePath, language, staged) =>
    set((s) => {
      const diffSource: DiffSource = staged ? 'staged' : 'unstaged'
      const id = `${worktreeId}::diff::${diffSource}::${relativePath}`
      const existing = s.openFiles.find((f) => f.id === id)
      if (existing) {
        const needsUpdate = existing.mode !== 'diff' || existing.diffSource !== diffSource
        return {
          openFiles: needsUpdate
            ? s.openFiles.map((f) =>
                f.id === id ? { ...f, mode: 'diff' as const, diffSource } : f
              )
            : s.openFiles,
          activeFileId: id,
          activeTabType: 'editor',
          activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
          activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
        }
      }
      const newFile: OpenFile = {
        id,
        filePath,
        relativePath,
        worktreeId,
        language,
        isDirty: false,
        mode: 'diff',
        diffSource
      }
      return {
        openFiles: [...s.openFiles, newFile],
        activeFileId: id,
        activeTabType: 'editor',
        activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
        activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
      }
    }),

  openBranchDiff: (worktreeId, worktreePath, entry, compare, language) =>
    set((s) => {
      const branchCompare = toBranchCompareSnapshot(compare)
      const id = `${worktreeId}::diff::branch::${compare.baseRef}::${branchCompare.compareVersion}::${entry.path}`
      const existing = s.openFiles.find((f) => f.id === id)
      if (existing) {
        return {
          openFiles: s.openFiles.map((f) =>
            f.id === id
              ? {
                  ...f,
                  mode: 'diff' as const,
                  diffSource: 'branch' as const,
                  branchCompare,
                  branchOldPath: entry.oldPath
                }
              : f
          ),
          activeFileId: id,
          activeTabType: 'editor',
          activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
          activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
        }
      }
      const newFile: OpenFile = {
        id,
        filePath: `${worktreePath}/${entry.path}`,
        relativePath: entry.path,
        worktreeId,
        language,
        isDirty: false,
        mode: 'diff',
        diffSource: 'branch',
        branchCompare,
        branchOldPath: entry.oldPath
      }
      return {
        openFiles: [...s.openFiles, newFile],
        activeFileId: id,
        activeTabType: 'editor',
        activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
        activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
      }
    }),

  openAllDiffs: (worktreeId, worktreePath, alternate, areaFilter) =>
    set((s) => {
      const id = areaFilter
        ? `${worktreeId}::all-diffs::uncommitted::${areaFilter}`
        : `${worktreeId}::all-diffs::uncommitted`
      const label = areaFilter
        ? ({ staged: 'Staged Changes', unstaged: 'Changes', untracked: 'Untracked Files' }[
            areaFilter
          ] ?? 'All Changes')
        : 'All Changes'
      const existing = s.openFiles.find((f) => f.id === id)
      if (existing) {
        return {
          openFiles: s.openFiles.map((f) =>
            f.id === id ? { ...f, combinedAlternate: alternate, combinedAreaFilter: areaFilter } : f
          ),
          activeFileId: id,
          activeTabType: 'editor',
          activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
          activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
        }
      }
      const newFile: OpenFile = {
        id,
        filePath: worktreePath,
        relativePath: label,
        worktreeId,
        language: 'plaintext',
        isDirty: false,
        mode: 'diff',
        diffSource: 'combined-uncommitted',
        combinedAlternate: alternate,
        combinedAreaFilter: areaFilter
      }
      return {
        openFiles: [...s.openFiles, newFile],
        activeFileId: id,
        activeTabType: 'editor',
        activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
        activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
      }
    }),

  openBranchAllDiffs: (worktreeId, worktreePath, compare, alternate) =>
    set((s) => {
      const branchCompare = toBranchCompareSnapshot(compare)
      const id = `${worktreeId}::all-diffs::branch::${compare.baseRef}::${branchCompare.compareVersion}`
      const existing = s.openFiles.find((f) => f.id === id)
      if (existing) {
        return {
          openFiles: s.openFiles.map((f) =>
            f.id === id ? { ...f, branchCompare, combinedAlternate: alternate } : f
          ),
          activeFileId: id,
          activeTabType: 'editor',
          activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
          activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
        }
      }
      const newFile: OpenFile = {
        id,
        filePath: worktreePath,
        relativePath: `Branch Changes (${compare.baseRef})`,
        worktreeId,
        language: 'plaintext',
        isDirty: false,
        mode: 'diff',
        diffSource: 'combined-branch',
        branchCompare,
        combinedAlternate: alternate
      }
      return {
        openFiles: [...s.openFiles, newFile],
        activeFileId: id,
        activeTabType: 'editor',
        activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
        activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
      }
    }),

  // Cursor line tracking
  editorCursorLine: {},
  setEditorCursorLine: (fileId, line) =>
    set((s) => ({
      editorCursorLine: { ...s.editorCursorLine, [fileId]: line }
    })),

  // Git status
  gitStatusByWorktree: {},
  setGitStatus: (worktreeId, entries) =>
    set((s) => {
      const prev = s.gitStatusByWorktree[worktreeId]
      if (
        prev &&
        prev.length === entries.length &&
        prev.every(
          (e, i) =>
            e.path === entries[i].path &&
            e.status === entries[i].status &&
            e.area === entries[i].area
        )
      ) {
        return s
      }
      return { gitStatusByWorktree: { ...s.gitStatusByWorktree, [worktreeId]: entries } }
    }),
  gitBranchChangesByWorktree: {},
  gitBranchCompareSummaryByWorktree: {},
  gitBranchCompareRequestKeyByWorktree: {},
  beginGitBranchCompareRequest: (worktreeId, requestKey, baseRef) =>
    set((s) => ({
      gitBranchCompareRequestKeyByWorktree: {
        ...s.gitBranchCompareRequestKeyByWorktree,
        [worktreeId]: requestKey
      },
      gitBranchCompareSummaryByWorktree: {
        ...s.gitBranchCompareSummaryByWorktree,
        [worktreeId]: {
          baseRef,
          baseOid: null,
          compareRef: 'HEAD',
          headOid: null,
          mergeBase: null,
          changedFiles: 0,
          status: 'loading'
        }
      }
    })),
  setGitBranchCompareResult: (worktreeId, requestKey, result) =>
    set((s) => {
      if (s.gitBranchCompareRequestKeyByWorktree[worktreeId] !== requestKey) {
        return s
      }
      const prevEntries = s.gitBranchChangesByWorktree[worktreeId]
      const prevSummary = s.gitBranchCompareSummaryByWorktree[worktreeId]
      const entriesUnchanged =
        prevEntries &&
        prevEntries.length === result.entries.length &&
        prevEntries.every(
          (e, i) =>
            e.path === result.entries[i].path &&
            e.status === result.entries[i].status &&
            e.oldPath === result.entries[i].oldPath
        )
      const summaryUnchanged =
        prevSummary &&
        prevSummary.status === result.summary.status &&
        prevSummary.baseOid === result.summary.baseOid &&
        prevSummary.headOid === result.summary.headOid &&
        prevSummary.changedFiles === result.summary.changedFiles
      if (entriesUnchanged && summaryUnchanged) {
        return s
      }
      return {
        gitBranchChangesByWorktree: entriesUnchanged
          ? s.gitBranchChangesByWorktree
          : { ...s.gitBranchChangesByWorktree, [worktreeId]: result.entries },
        gitBranchCompareSummaryByWorktree: summaryUnchanged
          ? s.gitBranchCompareSummaryByWorktree
          : { ...s.gitBranchCompareSummaryByWorktree, [worktreeId]: result.summary }
      }
    }),

  // File search
  fileSearchQuery: '',
  fileSearchCaseSensitive: false,
  fileSearchWholeWord: false,
  fileSearchUseRegex: false,
  fileSearchIncludePattern: '',
  fileSearchExcludePattern: '',
  fileSearchResults: null,
  fileSearchLoading: false,
  fileSearchCollapsedFiles: new Set<string>(),
  setFileSearchQuery: (query) => set({ fileSearchQuery: query }),
  setFileSearchCaseSensitive: (v) => set({ fileSearchCaseSensitive: v }),
  setFileSearchWholeWord: (v) => set({ fileSearchWholeWord: v }),
  setFileSearchUseRegex: (v) => set({ fileSearchUseRegex: v }),
  setFileSearchIncludePattern: (v) => set({ fileSearchIncludePattern: v }),
  setFileSearchExcludePattern: (v) => set({ fileSearchExcludePattern: v }),
  setFileSearchResults: (results) => set({ fileSearchResults: results }),
  setFileSearchLoading: (loading) => set({ fileSearchLoading: loading }),
  toggleFileSearchCollapsedFile: (filePath) =>
    set((s) => {
      const next = new Set(s.fileSearchCollapsedFiles)
      if (next.has(filePath)) {
        next.delete(filePath)
      } else {
        next.add(filePath)
      }
      return { fileSearchCollapsedFiles: next }
    }),
  clearFileSearch: () =>
    set({
      fileSearchQuery: '',
      fileSearchResults: null,
      fileSearchLoading: false,
      fileSearchCollapsedFiles: new Set<string>()
    }),

  // Editor navigation
  pendingEditorReveal: null,
  setPendingEditorReveal: (reveal) => set({ pendingEditorReveal: reveal }),

  // Quick open
  quickOpenVisible: false,
  setQuickOpenVisible: (visible) => set({ quickOpenVisible: visible })
})

function getCompareVersion(
  compare: Pick<GitBranchCompareSummary, 'baseOid' | 'headOid' | 'mergeBase'>
): string {
  return [
    compare.baseOid ?? 'no-base',
    compare.headOid ?? 'no-head',
    compare.mergeBase ?? 'no-merge-base'
  ].join(':')
}

function toBranchCompareSnapshot(compare: GitBranchCompareSummary): BranchCompareSnapshot {
  return {
    baseRef: compare.baseRef,
    baseOid: compare.baseOid,
    compareRef: compare.compareRef,
    headOid: compare.headOid,
    mergeBase: compare.mergeBase,
    compareVersion: getCompareVersion(compare)
  }
}
