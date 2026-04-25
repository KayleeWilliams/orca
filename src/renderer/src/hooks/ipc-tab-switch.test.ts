import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getStateMock, getActiveTabNavOrderMock } = vi.hoisted(() => ({
  getStateMock: vi.fn(),
  getActiveTabNavOrderMock: vi.fn()
}))

vi.mock('../store', () => ({
  useAppStore: {
    getState: getStateMock
  }
}))

vi.mock('@/components/tab-bar/group-tab-order', () => ({
  getActiveTabNavOrder: getActiveTabNavOrderMock
}))

import { handleSwitchTerminalTab } from './ipc-tab-switch'

type ActiveTabType = 'terminal' | 'editor' | 'browser'

function makeStore(activeTabType: ActiveTabType) {
  return {
    activeWorktreeId: 'wt-1',
    activeTabType,
    activeTabId: 'term-1',
    activeFileId: 'editor-1',
    activeBrowserTabId: 'browser-1',
    setActiveTab: vi.fn(),
    setActiveTabType: vi.fn()
  }
}

describe('handleSwitchTerminalTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips non-terminal tabs when switching forward', () => {
    const store = makeStore('terminal')
    store.activeTabId = 'term-2'
    getStateMock.mockReturnValue(store)
    getActiveTabNavOrderMock.mockReturnValue([
      { type: 'terminal', id: 'term-1' },
      { type: 'editor', id: 'editor-1' },
      { type: 'terminal', id: 'term-2' },
      { type: 'editor', id: 'editor-2' },
      { type: 'terminal', id: 'term-3' }
    ])

    expect(handleSwitchTerminalTab(1)).toBe(true)
    expect(store.setActiveTab).toHaveBeenCalledWith('term-3')
    expect(store.setActiveTabType).toHaveBeenCalledWith('terminal')
  })

  it('wraps from the last terminal to the first terminal', () => {
    const store = makeStore('terminal')
    store.activeTabId = 'term-3'
    getStateMock.mockReturnValue(store)
    getActiveTabNavOrderMock.mockReturnValue([
      { type: 'terminal', id: 'term-1' },
      { type: 'editor', id: 'editor-1' },
      { type: 'terminal', id: 'term-2' },
      { type: 'browser', id: 'browser-1' },
      { type: 'terminal', id: 'term-3' }
    ])

    expect(handleSwitchTerminalTab(1)).toBe(true)
    expect(store.setActiveTab).toHaveBeenCalledWith('term-1')
    expect(store.setActiveTabType).toHaveBeenCalledWith('terminal')
  })

  it('returns false when no terminal tabs exist', () => {
    const store = makeStore('editor')
    getStateMock.mockReturnValue(store)
    getActiveTabNavOrderMock.mockReturnValue([
      { type: 'editor', id: 'editor-1' },
      { type: 'browser', id: 'browser-1' }
    ])

    expect(handleSwitchTerminalTab(1)).toBe(false)
    expect(store.setActiveTab).not.toHaveBeenCalled()
    expect(store.setActiveTabType).not.toHaveBeenCalled()
  })

  it('returns false when only one terminal tab exists', () => {
    const store = makeStore('terminal')
    getStateMock.mockReturnValue(store)
    getActiveTabNavOrderMock.mockReturnValue([{ type: 'terminal', id: 'term-1' }])

    expect(handleSwitchTerminalTab(1)).toBe(false)
    expect(store.setActiveTab).not.toHaveBeenCalled()
    expect(store.setActiveTabType).not.toHaveBeenCalled()
  })

  it('jumps to the first terminal when an editor tab is active', () => {
    const store = makeStore('editor')
    store.activeFileId = 'editor-2'
    getStateMock.mockReturnValue(store)
    getActiveTabNavOrderMock.mockReturnValue([
      { type: 'terminal', id: 'term-1' },
      { type: 'editor', id: 'editor-1' },
      { type: 'terminal', id: 'term-2' },
      { type: 'editor', id: 'editor-2' },
      { type: 'terminal', id: 'term-3' }
    ])

    expect(handleSwitchTerminalTab(1)).toBe(true)
    expect(store.setActiveTab).toHaveBeenCalledWith('term-1')
    expect(store.setActiveTabType).toHaveBeenCalledWith('terminal')
  })
})
