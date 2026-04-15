import { useEffect, useCallback } from 'react'
import { useAppStore } from '@/store'
import type { DashboardRepoGroup } from './useDashboardData'
import type { DashboardFilter } from './useDashboardFilter'

type UseDashboardKeyboardParams = {
  filteredGroups: DashboardRepoGroup[]
  collapsedRepos: Set<string>
  focusedWorktreeId: string | null
  setFocusedWorktreeId: (id: string | null) => void
  filter: DashboardFilter
  setFilter: (f: DashboardFilter) => void
}

const FILTER_KEYS: Record<string, DashboardFilter> = {
  '1': 'active',
  '2': 'all',
  '3': 'working',
  '4': 'blocked',
  '5': 'done'
}

/** Collect all visible (non-collapsed) worktree IDs in display order. */
function getVisibleWorktreeIds(
  groups: DashboardRepoGroup[],
  collapsedRepos: Set<string>
): string[] {
  const ids: string[] = []
  for (const group of groups) {
    if (collapsedRepos.has(group.repo.id)) {
      continue
    }
    for (const card of group.worktrees) {
      ids.push(card.worktree.id)
    }
  }
  return ids
}

export function useDashboardKeyboard({
  filteredGroups,
  collapsedRepos,
  focusedWorktreeId,
  setFocusedWorktreeId,
  filter,
  setFilter
}: UseDashboardKeyboardParams): void {
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const rightSidebarTab = useAppStore((s) => s.rightSidebarTab)
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Only active when the dashboard pane is open and visible
      if (!rightSidebarOpen || rightSidebarTab !== 'dashboard') {
        return
      }

      // Don't intercept when focus is in an editable element
      const target = e.target as HTMLElement
      if (
        target.isContentEditable ||
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT'
      ) {
        return
      }

      // Don't intercept when a modifier key is held (let app shortcuts through)
      if (e.metaKey || e.ctrlKey || e.altKey) {
        return
      }

      // Filter quick-select: 1-4 keys
      if (FILTER_KEYS[e.key]) {
        e.preventDefault()
        setFilter(FILTER_KEYS[e.key])
        return
      }

      // Escape: reset filter to 'active' (the smart default)
      if (e.key === 'Escape') {
        if (filter !== 'active') {
          e.preventDefault()
          setFilter('active')
        }
        return
      }

      // Arrow key navigation
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault()
        const ids = getVisibleWorktreeIds(filteredGroups, collapsedRepos)
        if (ids.length === 0) {
          return
        }

        const currentIndex = focusedWorktreeId ? ids.indexOf(focusedWorktreeId) : -1

        let nextIndex: number
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
          nextIndex = currentIndex < ids.length - 1 ? currentIndex + 1 : 0
        } else {
          nextIndex = currentIndex > 0 ? currentIndex - 1 : ids.length - 1
        }

        const nextId = ids[nextIndex]
        setFocusedWorktreeId(nextId)

        // Focus the corresponding DOM card
        const cardEl = document.querySelector(`[data-worktree-id="${nextId}"]`) as HTMLElement
        cardEl?.focus()
        return
      }

      // Enter: navigate to focused worktree
      if (e.key === 'Enter' && focusedWorktreeId) {
        e.preventDefault()
        setActiveWorktree(focusedWorktreeId)
        setActiveView('terminal')
      }
    },
    [
      rightSidebarOpen,
      rightSidebarTab,
      filteredGroups,
      collapsedRepos,
      focusedWorktreeId,
      setFocusedWorktreeId,
      filter,
      setFilter,
      setActiveWorktree,
      setActiveView
    ]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])
}
