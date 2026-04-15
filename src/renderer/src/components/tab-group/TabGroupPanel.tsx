/* eslint-disable max-lines -- Why: group panels intentionally co-locate group-scoped tab chrome, activation/close handlers, and surface rendering so split groups cannot drift into a separate behavior path from the original root group. */
import { lazy, Suspense, useCallback, useMemo } from 'react'
import { X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { OpenFile } from '@/store/slices/editor'
import type { BrowserTab as BrowserTabState } from '../../../../shared/types'
import { useAppStore } from '../../store'
import TabBar from '../tab-bar/TabBar'
import TerminalPane from '../terminal-pane/TerminalPane'
import BrowserPane from '../browser-pane/BrowserPane'
import { useTabGroupController } from './useTabGroupController'

const EditorPanel = lazy(() => import('../editor/EditorPanel'))

type GroupEditorItem = OpenFile & { tabId: string }
const EMPTY_GROUPS: readonly never[] = []
const EMPTY_TABS: readonly never[] = []
const EMPTY_RUNTIME_TERMINALS: readonly never[] = []
const EMPTY_BROWSER_TABS: readonly never[] = []

export default function TabGroupPanel({
  groupId,
  worktreeId,
  isFocused,
  hasSplitGroups
}: {
  groupId: string
  worktreeId: string
  isFocused: boolean
  hasSplitGroups: boolean
}): React.JSX.Element {
  const worktreeGroups = useAppStore(
    useShallow((state) => state.groupsByWorktree[worktreeId] ?? EMPTY_GROUPS)
  )
  const worktreeUnifiedTabs = useAppStore(
    useShallow((state) => state.unifiedTabsByWorktree[worktreeId] ?? EMPTY_TABS)
  )
  const openFiles = useAppStore((state) => state.openFiles)
  const worktree = useAppStore(
    useShallow(
      (state) =>
        Object.values(state.worktreesByRepo)
          .flat()
          .find((candidate) => candidate.id === worktreeId) ?? null
    )
  )
  const focusGroup = useAppStore((state) => state.focusGroup)
  const setTabCustomTitle = useAppStore((state) => state.setTabCustomTitle)
  const setTabColor = useAppStore((state) => state.setTabColor)
  const consumeSuppressedPtyExit = useAppStore((state) => state.consumeSuppressedPtyExit)
  const expandedPaneByTabId = useAppStore((state) => state.expandedPaneByTabId)
  const browserTabsByWorktree = useAppStore((state) => state.browserTabsByWorktree)
  const runtimeTerminalTabs = useAppStore(
    (state) => state.tabsByWorktree[worktreeId] ?? EMPTY_RUNTIME_TERMINALS
  )

  const group = useMemo(
    () => worktreeGroups.find((item) => item.id === groupId) ?? null,
    [groupId, worktreeGroups]
  )
  const groupTabs = useMemo(
    () => worktreeUnifiedTabs.filter((item) => item.groupId === groupId),
    [groupId, worktreeUnifiedTabs]
  )

  const activeItemId = group?.activeTabId ?? null
  const activeTab = groupTabs.find((item) => item.id === activeItemId) ?? null

  const terminalTabs = useMemo(
    () =>
      groupTabs
        .filter((item) => item.contentType === 'terminal')
        .map((item) => ({
          id: item.entityId,
          ptyId: null,
          worktreeId,
          title: item.label,
          customTitle: item.customLabel,
          color: item.color,
          sortOrder: item.sortOrder,
          createdAt: item.createdAt
        })),
    [groupTabs, worktreeId]
  )

  const editorItems = useMemo<GroupEditorItem[]>(
    () =>
      groupTabs
        .filter(
          (item) =>
            item.contentType === 'editor' ||
            item.contentType === 'diff' ||
            item.contentType === 'conflict-review'
        )
        .map((item) => {
          const file = openFiles.find((candidate) => candidate.id === item.entityId)
          return file ? { ...file, tabId: item.id } : null
        })
        .filter((item): item is GroupEditorItem => item !== null),
    [groupTabs, openFiles]
  )

  const worktreeBrowserTabs = useMemo(
    () => browserTabsByWorktree[worktreeId] ?? EMPTY_BROWSER_TABS,
    [browserTabsByWorktree, worktreeId]
  )

  const browserItems = useMemo(
    () =>
      groupTabs
        .filter((item) => item.contentType === 'browser')
        .map((item) => {
          const bt = worktreeBrowserTabs.find((candidate) => candidate.id === item.entityId)
          return bt ?? null
        })
        .filter((item): item is BrowserTabState => item !== null),
    [groupTabs, worktreeBrowserTabs]
  )

  const activeBrowserTab = useMemo(
    () =>
      activeTab?.contentType === 'browser'
        ? (worktreeBrowserTabs.find((bt) => bt.id === activeTab.entityId) ?? null)
        : null,
    [activeTab, worktreeBrowserTabs]
  )

  const runtimeTerminalTabById = useMemo(
    () => new Map(runtimeTerminalTabs.map((tab) => [tab.id, tab])),
    [runtimeTerminalTabs]
  )

  const controller = useTabGroupController({
    groupId,
    worktreeId,
    group,
    groupTabs,
    activeTab,
    worktreeBrowserTabs
  })

  const handleTerminalClose = useCallback(
    (terminalId: string) => {
      const item = groupTabs.find(
        (candidate) => candidate.entityId === terminalId && candidate.contentType === 'terminal'
      )
      if (item) {
        controller.closeItem(item.id)
      }
    },
    [controller, groupTabs]
  )

  const handleBrowserClose = useCallback(
    (browserTabId: string) => {
      const item = groupTabs.find(
        (candidate) => candidate.entityId === browserTabId && candidate.contentType === 'browser'
      )
      if (item) {
        controller.closeItem(item.id)
      }
    },
    [controller, groupTabs]
  )

  const tabBar = (
    <TabBar
      tabs={terminalTabs}
      activeTabId={activeTab?.contentType === 'terminal' ? activeTab.entityId : null}
      worktreeId={worktreeId}
      expandedPaneByTabId={expandedPaneByTabId}
      onActivate={controller.activateTerminal}
      onClose={handleTerminalClose}
      onCloseOthers={(terminalId) => {
        const item = groupTabs.find(
          (candidate) => candidate.entityId === terminalId && candidate.contentType === 'terminal'
        )
        if (item) {
          controller.closeOthers(item.id)
        }
      }}
      onCloseToRight={(terminalId) => {
        const item = groupTabs.find(
          (candidate) => candidate.entityId === terminalId && candidate.contentType === 'terminal'
        )
        if (item) {
          controller.closeToRight(item.id)
        }
      }}
      onReorder={(_, order) => controller.reorderTabBar(order)}
      onNewTerminalTab={controller.newTerminalTab}
      onNewBrowserTab={controller.newBrowserTab}
      onSetCustomTitle={setTabCustomTitle}
      onSetTabColor={setTabColor}
      onTogglePaneExpand={() => {}}
      editorFiles={editorItems}
      browserTabs={browserItems}
      activeFileId={
        activeTab?.contentType === 'terminal' || activeTab?.contentType === 'browser'
          ? null
          : activeTab?.id
      }
      activeBrowserTabId={activeTab?.contentType === 'browser' ? activeTab.entityId : null}
      activeTabType={
        activeTab?.contentType === 'terminal'
          ? 'terminal'
          : activeTab?.contentType === 'browser'
            ? 'browser'
            : 'editor'
      }
      onActivateFile={controller.activateEditor}
      onCloseFile={controller.closeItem}
      onActivateBrowserTab={controller.activateBrowser}
      onCloseBrowserTab={handleBrowserClose}
      onCloseAllFiles={controller.closeAllEditorTabsInGroup}
      onPinFile={(_fileId, tabId) => {
        if (!tabId) {
          return
        }
        const item = groupTabs.find((candidate) => candidate.id === tabId)
        if (!item) {
          return
        }
        controller.pinFile(item.entityId, item.id)
      }}
      tabBarOrder={controller.tabBarOrder}
      onCreateSplitGroup={controller.createSplitGroup}
    />
  )

  return (
    <div
      className={`flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden${
        hasSplitGroups
          ? ` group/tab-group border ${isFocused ? 'border-accent' : 'border-border'}`
          : ''
      }`}
      onPointerDown={() => focusGroup(worktreeId, groupId)}
    >
      {/* Why: every split group must keep its own real tab row because the app
          can show multiple groups at once, while the window titlebar only has
          one shared center slot. Rendering true tab chrome here preserves
          per-group titles without making groups fight over one portal target. */}
      <div className="shrink-0 border-b border-border bg-card">
        <div className="flex items-stretch">
          <div className="min-w-0 flex-1">{tabBar}</div>
          {hasSplitGroups && (
            <button
              type="button"
              aria-label="Close Group"
              title="Close Group"
              onClick={(event) => {
                event.stopPropagation()
                controller.closeGroup()
              }}
              className="mx-1 my-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
      </div>

      <div className="relative flex-1 min-h-0 overflow-hidden">
        {groupTabs
          .filter((item) => item.contentType === 'terminal')
          .map((item) => (
            <TerminalPane
              key={`${item.entityId}-${runtimeTerminalTabById.get(item.entityId)?.generation ?? 0}`}
              tabId={item.entityId}
              worktreeId={worktreeId}
              cwd={worktree?.path}
              isActive={
                isFocused && activeTab?.id === item.id && activeTab.contentType === 'terminal'
              }
              // Why: in multi-group splits, the active terminal in each group
              // must remain visible (display:flex) so the user sees its output,
              // but only the focused group's terminal should receive keyboard
              // input. isVisible controls rendering; isActive controls focus.
              isVisible={activeTab?.id === item.id && activeTab.contentType === 'terminal'}
              onPtyExit={(ptyId) => {
                if (consumeSuppressedPtyExit(ptyId)) {
                  return
                }
                controller.closeItem(item.id)
              }}
              onCloseTab={() => controller.closeItem(item.id)}
            />
          ))}

        {activeTab &&
          activeTab.contentType !== 'terminal' &&
          activeTab.contentType !== 'browser' && (
            <div className="absolute inset-0 flex min-h-0 min-w-0">
              {/* Why: split groups render editor/browser content inside a
                  plain relative pane body instead of the legacy flex column in
                  Terminal.tsx. Anchoring the surface to `absolute inset-0`
                  recreates the bounded viewport those panes expect, so plain
                  overflow containers like MarkdownPreview can actually scroll
                  instead of expanding to content height. */}
              <Suspense
                fallback={
                  <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    Loading editor...
                  </div>
                }
              >
                <EditorPanel activeFileId={activeTab.entityId} activeViewStateId={activeTab.id} />
              </Suspense>
            </div>
          )}

        {browserItems.map((bt) => (
          <div
            key={bt.id}
            className="absolute inset-0 flex min-h-0 min-w-0"
            style={{ display: activeBrowserTab?.id === bt.id ? undefined : 'none' }}
          >
            <BrowserPane browserTab={bt} isActive={activeBrowserTab?.id === bt.id} />
          </div>
        ))}
      </div>
    </div>
  )
}
