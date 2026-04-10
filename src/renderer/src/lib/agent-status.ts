import type { TerminalTab, Worktree } from '../../../shared/types'
import type { AgentStatusEntry, AgentType } from '../../../shared/agent-status-types'

// Re-export from shared module so existing renderer imports continue to work.
// Why: the main process now needs the same agent detection logic for stat
// tracking. Moving to shared avoids duplicating the detection code.
export {
  type AgentStatus,
  detectAgentStatusFromTitle,
  clearWorkingIndicators,
  createAgentStatusTracker,
  normalizeTerminalTitle,
  isGeminiTerminalTitle,
  isClaudeAgent,
  getAgentLabel
} from '../../../shared/agent-detection'
import {
  type AgentStatus,
  detectAgentStatusFromTitle,
  isGeminiTerminalTitle,
  isClaudeAgent,
  getAgentLabel
} from '../../../shared/agent-detection'

type AgentQueryArgs = {
  tabsByWorktree: Record<string, TerminalTab[]>
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  worktreesByRepo: Record<string, Worktree[]>
}

export type WorkingAgentEntry = {
  label: string
  status: AgentStatus
  tabId: string
  paneId: number | null
}

export type WorktreeAgents = {
  agents: WorkingAgentEntry[]
}

export function getWorkingAgentsPerWorktree({
  tabsByWorktree,
  runtimePaneTitlesByTabId,
  worktreesByRepo
}: AgentQueryArgs): Record<string, WorktreeAgents> {
  const validIds = collectWorktreeIds(worktreesByRepo)
  const result: Record<string, WorktreeAgents> = {}

  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    // Why: tabsByWorktree can retain orphaned entries for worktrees that no
    // longer exist in git (e.g. deleted worktrees whose tab cleanup didn't
    // complete, or worktrees removed outside Orca). worktreesByRepo is the
    // source of truth — only include worktrees that still exist.
    if (!validIds.has(worktreeId)) {
      continue
    }
    const agents: WorkingAgentEntry[] = []

    for (const tab of tabs) {
      const paneTitles = runtimePaneTitlesByTabId[tab.id]
      if (paneTitles && Object.keys(paneTitles).length > 0) {
        for (const [paneIdStr, title] of Object.entries(paneTitles)) {
          if (detectAgentStatusFromTitle(title) === 'working') {
            const label = getAgentLabel(title)
            if (label) {
              agents.push({
                label,
                status: 'working',
                tabId: tab.id,
                paneId: Number(paneIdStr)
              })
            }
          }
        }
      } else if (tab.ptyId && detectAgentStatusFromTitle(tab.title) === 'working') {
        const label = getAgentLabel(tab.title)
        if (label) {
          agents.push({ label, status: 'working', tabId: tab.id, paneId: null })
        }
      }
    }

    if (agents.length > 0) {
      result[worktreeId] = { agents }
    }
  }

  return result
}

function includesAgentName(title: string, name: string): boolean {
  return title.toLowerCase().includes(name)
}

// Why: inferAgentTypeFromTitle classifies a terminal title into a known agent
// family so the dashboard can display the correct agent icon/label without
// relying on the explicit hook-based status report (which may not be available
// for all agent types).
export function inferAgentTypeFromTitle(title: string | null | undefined): AgentType {
  if (!title) {
    return 'unknown'
  }
  if (isGeminiTerminalTitle(title)) {
    return 'gemini'
  }
  if (isClaudeAgent(title)) {
    return 'claude'
  }
  if (includesAgentName(title, 'codex')) {
    return 'codex'
  }
  if (includesAgentName(title, 'opencode')) {
    return 'opencode'
  }
  if (includesAgentName(title, 'aider')) {
    return 'aider'
  }
  return 'unknown'
}

export function formatAgentTypeLabel(agentType: AgentType | null | undefined): string {
  switch (agentType) {
    case 'claude':
      return 'Claude'
    case 'codex':
      return 'Codex'
    case 'gemini':
      return 'Gemini'
    case 'opencode':
      return 'OpenCode'
    case 'aider':
      return 'Aider'
    default:
      return 'Unknown agent'
  }
}

// Why: explicit agent status entries (from hook-based reports) can go stale if
// the agent process exits without sending a final update. This helper lets
// callers decide whether to trust the entry based on a configurable TTL.
export function isExplicitAgentStatusFresh(
  entry: Pick<AgentStatusEntry, 'updatedAt'>,
  now: number,
  staleAfterMs: number
): boolean {
  return now - entry.updatedAt <= staleAfterMs
}

export function countWorkingAgents({
  tabsByWorktree,
  runtimePaneTitlesByTabId,
  worktreesByRepo
}: AgentQueryArgs): number {
  const validIds = collectWorktreeIds(worktreesByRepo)
  let count = 0

  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    if (!validIds.has(worktreeId)) {
      continue
    }
    for (const tab of tabs) {
      count += countWorkingAgentsForTab(tab, runtimePaneTitlesByTabId)
    }
  }

  return count
}

function collectWorktreeIds(worktreesByRepo: Record<string, Worktree[]>): Set<string> {
  const ids = new Set<string>()
  for (const worktrees of Object.values(worktreesByRepo)) {
    for (const wt of worktrees) {
      ids.add(wt.id)
    }
  }
  return ids
}

function countWorkingAgentsForTab(
  tab: TerminalTab,
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
): number {
  let count = 0
  const paneTitles = runtimePaneTitlesByTabId[tab.id]
  // Why: split-pane tabs can host multiple concurrent agents, but the
  // legacy tab title only reflects the last pane title update that won the
  // tab label. Prefer pane-level titles whenever TerminalPane is mounted,
  // and fall back to the tab title only for tabs we have not mounted yet
  // (for example restored-but-unvisited worktrees).
  if (paneTitles && Object.keys(paneTitles).length > 0) {
    for (const title of Object.values(paneTitles)) {
      if (detectAgentStatusFromTitle(title) === 'working') {
        count += 1
      }
    }
    return count
  }
  // Why: restored session tabs can keep the last agent title even before a
  // PTY reconnects (or after the PTY is gone). Count only live PTY-backed
  // tab fallbacks so the titlebar matches the sidebar's notion of
  // "actively running" instead of surfacing stale pre-shutdown state.
  if (tab.ptyId && detectAgentStatusFromTitle(tab.title) === 'working') {
    count += 1
  }
  return count
}
