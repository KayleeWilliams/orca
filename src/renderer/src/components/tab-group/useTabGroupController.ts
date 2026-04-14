import { useCallback, useMemo } from 'react'
import type { BrowserTab as BrowserTabState, Tab } from '../../../../shared/types'
import { useAppStore } from '../../store'
import { destroyPersistentWebview } from '../browser-pane/BrowserPane'

export function useTabGroupController({
  groupId,
  worktreeId,
  group,
  groupTabs,
  activeTab,
  worktreeBrowserTabs
}: {
  groupId: string
  worktreeId: string
  group: { id: string; tabOrder: string[] } | null
  groupTabs: Tab[]
  activeTab: Tab | null
  worktreeBrowserTabs: BrowserTabState[]
}) {
  const focusGroup = useAppStore((state) => state.focusGroup)
  const activateTab = useAppStore((state) => state.activateTab)
  const closeUnifiedTab = useAppStore((state) => state.closeUnifiedTab)
  const closeOtherTabs = useAppStore((state) => state.closeOtherTabs)
  const closeTabsToRight = useAppStore((state) => state.closeTabsToRight)
  const reorderUnifiedTabs = useAppStore((state) => state.reorderUnifiedTabs)
  const createEmptySplitGroup = useAppStore((state) => state.createEmptySplitGroup)
  const createTab = useAppStore((state) => state.createTab)
  const closeTab = useAppStore((state) => state.closeTab)
  const setActiveTab = useAppStore((state) => state.setActiveTab)
  const setActiveFile = useAppStore((state) => state.setActiveFile)
  const setActiveTabType = useAppStore((state) => state.setActiveTabType)
  const createBrowserTab = useAppStore((state) => state.createBrowserTab)
  const closeFile = useAppStore((state) => state.closeFile)
  const closeAllFiles = useAppStore((state) => state.closeAllFiles)
  const pinFile = useAppStore((state) => state.pinFile)
  const closeBrowserTab = useAppStore((state) => state.closeBrowserTab)
  const setActiveBrowserTab = useAppStore((state) => state.setActiveBrowserTab)
  const copyUnifiedTabToGroup = useAppStore((state) => state.copyUnifiedTabToGroup)

  const closeEditorIfUnreferenced = useCallback(
    (entityId: string, closingTabId: string) => {
      const otherReference = (useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []).some(
        (item) =>
          item.id !== closingTabId &&
          item.entityId === entityId &&
          (item.contentType === 'editor' ||
            item.contentType === 'diff' ||
            item.contentType === 'conflict-review')
      )
      if (!otherReference) {
        closeFile(entityId)
      }
    },
    [closeFile, worktreeId]
  )

  const closeItem = useCallback(
    (itemId: string) => {
      const item = groupTabs.find((candidate) => candidate.id === itemId)
      if (!item) {
        return
      }
      if (item.contentType === 'terminal') {
        closeTab(item.entityId)
      } else if (item.contentType === 'browser') {
        destroyPersistentWebview(item.entityId)
        closeBrowserTab(item.entityId)
      } else {
        closeEditorIfUnreferenced(item.entityId, item.id)
        closeUnifiedTab(item.id)
      }
    },
    [closeBrowserTab, closeEditorIfUnreferenced, closeTab, closeUnifiedTab, groupTabs]
  )

  const closeMany = useCallback(
    (itemIds: string[]) => {
      for (const itemId of itemIds) {
        const item = groupTabs.find((candidate) => candidate.id === itemId)
        if (!item) {
          continue
        }
        if (item.contentType === 'terminal') {
          closeTab(item.entityId)
        } else if (item.contentType === 'browser') {
          destroyPersistentWebview(item.entityId)
          closeBrowserTab(item.entityId)
        } else {
          closeEditorIfUnreferenced(item.entityId, item.id)
        }
      }
    },
    [closeBrowserTab, closeEditorIfUnreferenced, closeTab, groupTabs]
  )

  const activateTerminal = useCallback(
    (terminalId: string) => {
      const item = groupTabs.find(
        (candidate) => candidate.entityId === terminalId && candidate.contentType === 'terminal'
      )
      if (!item) {
        return
      }
      focusGroup(worktreeId, groupId)
      activateTab(item.id)
      setActiveTab(terminalId)
      setActiveTabType('terminal')
    },
    [activateTab, focusGroup, groupId, groupTabs, setActiveTab, setActiveTabType, worktreeId]
  )

  const activateEditor = useCallback(
    (tabId: string) => {
      const item = groupTabs.find((candidate) => candidate.id === tabId)
      if (!item) {
        return
      }
      focusGroup(worktreeId, groupId)
      activateTab(item.id)
      setActiveFile(item.entityId)
      setActiveTabType('editor')
    },
    [activateTab, focusGroup, groupId, groupTabs, setActiveFile, setActiveTabType, worktreeId]
  )

  const activateBrowser = useCallback(
    (browserTabId: string) => {
      const item = groupTabs.find(
        (candidate) => candidate.entityId === browserTabId && candidate.contentType === 'browser'
      )
      if (!item) {
        return
      }
      focusGroup(worktreeId, groupId)
      activateTab(item.id)
      setActiveBrowserTab(browserTabId)
      setActiveTabType('browser')
    },
    [activateTab, focusGroup, groupId, groupTabs, setActiveBrowserTab, setActiveTabType, worktreeId]
  )

  const createSplitGroup = useCallback(
    (direction: 'left' | 'right' | 'up' | 'down') => {
      focusGroup(worktreeId, groupId)
      const newGroupId = createEmptySplitGroup(worktreeId, groupId, direction)
      if (!newGroupId || !activeTab) {
        return
      }

      // Why: VS Code-style split actions leave the original group untouched and
      // seed the new group with equivalent visible content when possible.
      if (activeTab.contentType === 'terminal') {
        const terminal = createTab(worktreeId, newGroupId)
        setActiveTab(terminal.id)
        setActiveTabType('terminal')
        return
      }

      if (activeTab.contentType === 'browser') {
        const browserTab = worktreeBrowserTabs.find(
          (candidate) => candidate.id === activeTab.entityId
        )
        if (!browserTab) {
          return
        }
        createBrowserTab(browserTab.worktreeId, browserTab.url, {
          title: browserTab.title,
          sessionProfileId: browserTab.sessionProfileId
        })
        return
      }

      copyUnifiedTabToGroup(activeTab.id, newGroupId, {
        entityId: activeTab.entityId,
        label: activeTab.label,
        isPinned: activeTab.isPinned
      })
      setActiveFile(activeTab.entityId)
      setActiveTabType('editor')
    },
    [
      activeTab,
      createBrowserTab,
      createEmptySplitGroup,
      createTab,
      copyUnifiedTabToGroup,
      focusGroup,
      groupId,
      setActiveFile,
      setActiveTab,
      setActiveTabType,
      worktreeBrowserTabs,
      worktreeId
    ]
  )

  const tabBarOrder = useMemo(
    () =>
      (group?.tabOrder ?? []).map((itemId) => {
        const item = groupTabs.find((candidate) => candidate.id === itemId)
        if (!item) {
          return itemId
        }
        // Why: the tab bar renders terminals and browser workspaces by their
        // backing runtime IDs, while editor tabs render by their unified tab
        // IDs. Reorder callbacks must round-trip through the same visible IDs
        // or dnd-kit cannot map the dragged tab back to the stored group order.
        return item.contentType === 'terminal' || item.contentType === 'browser'
          ? item.entityId
          : item.id
      }),
    [group, groupTabs]
  )

  return {
    activateTerminal,
    activateEditor,
    activateBrowser,
    closeItem,
    closeGroup: () => {
      const items = [...(useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? [])].filter(
        (item) => item.groupId === groupId
      )
      for (const item of items) {
        closeItem(item.id)
      }
    },
    closeOthers: (itemId: string) => closeMany(closeOtherTabs(itemId)),
    closeToRight: (itemId: string) => closeMany(closeTabsToRight(itemId)),
    reorderTabBar: (order: string[]) => {
      if (!group) {
        return
      }
      const itemOrder = order
        .map(
          (visibleId) =>
            groupTabs.find((item) =>
              item.contentType === 'terminal' || item.contentType === 'browser'
                ? item.entityId === visibleId
                : item.id === visibleId
            )?.id
        )
        .filter((value): value is string => Boolean(value))
      const orderedIds = new Set(itemOrder)
      const remainingIds = group.tabOrder.filter((itemId) => !orderedIds.has(itemId))
      reorderUnifiedTabs(groupId, itemOrder.concat(remainingIds))
    },
    newTerminalTab: () => {
      const terminal = createTab(worktreeId, groupId)
      setActiveTab(terminal.id)
      setActiveTabType('terminal')
    },
    newBrowserTab: () => {
      const defaultUrl = useAppStore.getState().browserDefaultUrl ?? 'about:blank'
      createBrowserTab(worktreeId, defaultUrl, { title: 'New Browser Tab' })
    },
    closeAllFiles,
    pinFile,
    copyUnifiedTabToGroup,
    tabBarOrder,
    createSplitGroup
  }
}
