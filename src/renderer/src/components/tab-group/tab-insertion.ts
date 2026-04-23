import { useCallback, useState } from 'react'
import type { DragMoveEvent, DragOverEvent } from '@dnd-kit/core'
import type { TabDragItemData } from './useTabDragSplit'

// Why: when a tab is dragged over another tab's sortable rect, we compute
// which side of the hovered tab the drop will land on (before vs. after).
// Rendering a blue insertion bar at that edge makes the drop target feel
// VS Code-like even though dnd-kit's default sortable animation already
// slides tabs apart.
export type HoveredTabInsertion = {
  groupId: string
  visibleTabId: string
  side: 'left' | 'right'
}

function resolve(
  event: DragMoveEvent | DragOverEvent,
  isTabDragData: (value: unknown) => value is TabDragItemData,
  getDragCenter: (event: DragMoveEvent | DragOverEvent) => { x: number; y: number } | null
): HoveredTabInsertion | null {
  const overData = event.over?.data.current
  const activeData = event.active.data.current
  if (!event.over || !isTabDragData(activeData) || !isTabDragData(overData)) {
    return null
  }
  // Why: dropping a tab onto itself is a no-op — suppress the indicator there
  // so users don't see a false positive target.
  if (activeData.unifiedTabId === overData.unifiedTabId) {
    return null
  }
  const center = getDragCenter(event)
  if (!center) {
    return null
  }
  const midpoint = event.over.rect.left + event.over.rect.width / 2
  return {
    groupId: overData.groupId,
    visibleTabId: overData.visibleTabId,
    side: center.x < midpoint ? 'left' : 'right'
  }
}

function equal(a: HoveredTabInsertion | null, b: HoveredTabInsertion | null): boolean {
  if (a === b) {
    return true
  }
  return (
    a !== null &&
    b !== null &&
    a.groupId === b.groupId &&
    a.visibleTabId === b.visibleTabId &&
    a.side === b.side
  )
}

export function useHoveredTabInsertion(
  isTabDragData: (value: unknown) => value is TabDragItemData,
  getDragCenter: (event: DragMoveEvent | DragOverEvent) => { x: number; y: number } | null
): {
  hoveredTabInsertion: HoveredTabInsertion | null
  update: (event: DragMoveEvent | DragOverEvent) => void
  clear: () => void
} {
  const [hoveredTabInsertion, setHoveredTabInsertion] = useState<HoveredTabInsertion | null>(null)
  const update = useCallback(
    (event: DragMoveEvent | DragOverEvent) => {
      const next = resolve(event, isTabDragData, getDragCenter)
      setHoveredTabInsertion((prev) => (equal(prev, next) ? prev : next))
    },
    [isTabDragData, getDragCenter]
  )
  const clear = useCallback(() => setHoveredTabInsertion(null), [])
  return { hoveredTabInsertion, update, clear }
}
