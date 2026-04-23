import { describe, expect, it } from 'vitest'
import { resolveTabIndicatorEdges, type HoveredTabInsertion } from './tab-insertion'

describe('resolveTabIndicatorEdges', () => {
  it('marks both tabs around a left-edge insertion slot', () => {
    const hovered: HoveredTabInsertion = {
      groupId: 'group-1',
      visibleTabId: 'tab-2',
      side: 'left'
    }

    expect(resolveTabIndicatorEdges(['tab-1', 'tab-2', 'tab-3'], hovered)).toEqual([
      { visibleTabId: 'tab-1', side: 'right' },
      { visibleTabId: 'tab-2', side: 'left' }
    ])
  })

  it('marks both tabs around a right-edge insertion slot', () => {
    const hovered: HoveredTabInsertion = {
      groupId: 'group-1',
      visibleTabId: 'tab-2',
      side: 'right'
    }

    expect(resolveTabIndicatorEdges(['tab-1', 'tab-2', 'tab-3'], hovered)).toEqual([
      { visibleTabId: 'tab-2', side: 'right' },
      { visibleTabId: 'tab-3', side: 'left' }
    ])
  })

  it('keeps a single edge marker at the strip boundaries', () => {
    expect(
      resolveTabIndicatorEdges(['tab-1', 'tab-2'], {
        groupId: 'group-1',
        visibleTabId: 'tab-1',
        side: 'left'
      })
    ).toEqual([{ visibleTabId: 'tab-1', side: 'left' }])

    expect(
      resolveTabIndicatorEdges(['tab-1', 'tab-2'], {
        groupId: 'group-1',
        visibleTabId: 'tab-2',
        side: 'right'
      })
    ).toEqual([{ visibleTabId: 'tab-2', side: 'right' }])
  })
})
