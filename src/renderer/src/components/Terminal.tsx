import { lazy, Suspense } from 'react'
import { useAppStore } from '../store'
import { TerminalShell } from './terminal/TerminalShell'
import { useTerminalSaveDialog } from './terminal/useTerminalSaveDialog'
import { useTerminalShortcuts } from './terminal/useTerminalShortcuts'
import { useTerminalTabs } from './terminal/useTerminalTabs'

const EditorPanel = lazy(() => import('./editor/EditorPanel'))

export default function Terminal(): React.JSX.Element | null {
  const openFiles = useAppStore((s) => s.openFiles)
  const closeFile = useAppStore((s) => s.closeFile)
  const markFileDirty = useAppStore((s) => s.markFileDirty)

  const saveDialog = useTerminalSaveDialog({ openFiles, closeFile, markFileDirty })
  const terminalTabs = useTerminalTabs()

  useTerminalShortcuts({
    activeWorktreeId: terminalTabs.activeWorktreeId,
    activeTabId: terminalTabs.activeTabId,
    activeFileId: terminalTabs.activeFileId,
    activeTabType: terminalTabs.activeTabType,
    unifiedTabs: terminalTabs.unifiedTabs,
    hasDirtyFiles: openFiles.some((file) => file.isDirty),
    onNewTab: terminalTabs.handleNewTab,
    onCloseTab: terminalTabs.handleCloseTab,
    onCloseFile: saveDialog.requestCloseFile,
    onActivateTerminalTab: terminalTabs.handleActivateTab,
    onActivateEditorTab: terminalTabs.handleActivateFile
  })

  return (
    <TerminalShell
      activeWorktreeId={terminalTabs.activeWorktreeId}
      activeView={terminalTabs.activeView}
      totalTabs={terminalTabs.totalTabs}
      tabs={terminalTabs.tabs}
      activeTabId={terminalTabs.activeTabId}
      activeFileId={terminalTabs.activeFileId}
      activeTabType={terminalTabs.activeTabType}
      expandedPaneByTabId={terminalTabs.expandedPaneByTabId}
      worktreeFiles={terminalTabs.worktreeFiles}
      mountedWorktrees={terminalTabs.mountedWorktrees}
      tabsByWorktree={terminalTabs.tabsByWorktree}
      onActivateTab={terminalTabs.handleActivateTab}
      onCloseTab={terminalTabs.handleCloseTab}
      onCloseOthers={terminalTabs.handleCloseOthers}
      onCloseTabsToRight={terminalTabs.handleCloseTabsToRight}
      onReorderTabs={terminalTabs.reorderTabs}
      onNewTab={terminalTabs.handleNewTab}
      onSetCustomTitle={terminalTabs.setTabCustomTitle}
      onSetTabColor={terminalTabs.setTabColor}
      onTogglePaneExpand={terminalTabs.handleTogglePaneExpand}
      onActivateFile={terminalTabs.handleActivateFile}
      onCloseFile={saveDialog.requestCloseFile}
      onCloseAllFiles={terminalTabs.closeAllFiles}
      onPtyExit={terminalTabs.handlePtyExit}
      editorPanel={
        <Suspense
          fallback={
            <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
              Loading editor...
            </div>
          }
        >
          <EditorPanel />
        </Suspense>
      }
      saveDialogFileId={saveDialog.saveDialogFileId}
      saveDialogFile={saveDialog.saveDialogFile}
      onSaveDialogOpenChange={(open) => {
        if (!open) {
          saveDialog.handleSaveDialogCancel()
        }
      }}
      onSaveDialogCancel={saveDialog.handleSaveDialogCancel}
      onSaveDialogDiscard={saveDialog.handleSaveDialogDiscard}
      onSaveDialogSave={saveDialog.handleSaveDialogSave}
    />
  )
}
