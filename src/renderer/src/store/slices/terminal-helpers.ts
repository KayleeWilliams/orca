import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/types'
import { detectAgentStatusFromTitle } from '@/lib/agent-status'

export function emptyLayoutSnapshot(): TerminalLayoutSnapshot {
  return {
    root: null,
    activeLeafId: null,
    expandedLeafId: null
  }
}

export function clearTransientTerminalState(tab: TerminalTab, index: number): TerminalTab {
  return {
    ...tab,
    ptyId: null,
    title: getResetTitle(tab, index)
  }
}

function getResetTitle(tab: TerminalTab, index: number): string {
  const fallbackTitle = tab.customTitle?.trim() || `Terminal ${index + 1}`
  return detectAgentStatusFromTitle(tab.title) ? fallbackTitle : tab.title
}
