import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  AGENT_STATE_HISTORY_MAX,
  type AgentStateHistoryEntry,
  type AgentStatusEntry,
  type AgentType,
  type ParsedAgentStatusPayload
} from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/types'

/** Snapshot of a finished (or vanished) agent status entry, kept around so
 *  the dashboard + sidebar hover can continue showing the completion until the
 *  user acknowledges it by clicking the worktree. The `worktreeId` is stamped
 *  at retention time so we know where the row belongs even after the tab/pty
 *  it came from has gone away. */
export type RetainedAgentEntry = {
  entry: AgentStatusEntry
  worktreeId: string
  /** Snapshot of the tab the agent lived in at retention time. We keep the
   *  full record (not just an id) because the tab may be gone from
   *  `tabsByWorktree` by the time the retained row is rendered. */
  tab: TerminalTab
  agentType: AgentType
  startedAt: number
}

export type AgentStatusSlice = {
  /** Explicit agent status entries keyed by `${tabId}:${paneId}` composite.
   *  Real-time only — lives in renderer memory, not persisted to disk. */
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  /** Monotonic tick that advances when agent-status freshness boundaries pass. */
  agentStatusEpoch: number

  /** Retained "done" entries — snapshots of agents that have disappeared from
   *  `agentStatusByPaneKey`. Keyed by paneKey so re-appearance of the same pane
   *  overwrites the snapshot. Shared between the dashboard and the sidebar
   *  agent-status hover so the two surfaces display identical rows. */
  retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>

  /** Update or insert an agent status entry from a status payload. */
  setAgentStatus: (
    paneKey: string,
    payload: ParsedAgentStatusPayload,
    terminalTitle?: string
  ) => void

  /** Remove a single entry (e.g., when a pane's terminal exits). */
  removeAgentStatus: (paneKey: string) => void

  /** Remove all entries whose paneKey starts with the given prefix.
   *  Used when a tab is closed — same prefix-sweep as cacheTimerByKey cleanup. */
  removeAgentStatusByTabPrefix: (tabIdPrefix: string) => void

  /** Retain an agent snapshot (called by the top-level retention sync effect). */
  retainAgent: (retained: RetainedAgentEntry) => void

  /** Dismiss a retained entry by its paneKey. */
  dismissRetainedAgent: (paneKey: string) => void

  /** Dismiss all retained entries belonging to a worktree. */
  dismissRetainedAgentsByWorktree: (worktreeId: string) => void

  /** Prune retained entries whose worktreeId is not in the given set. */
  pruneRetainedAgents: (validWorktreeIds: Set<string>) => void
}

export const createAgentStatusSlice: StateCreator<AppState, [], [], AgentStatusSlice> = (
  set,
  get
) => {
  let staleExpiryTimer: ReturnType<typeof setTimeout> | null = null

  const clearStaleExpiryTimer = (): void => {
    if (staleExpiryTimer !== null) {
      clearTimeout(staleExpiryTimer)
      staleExpiryTimer = null
    }
  }

  const scheduleNextFreshnessExpiry = (): void => {
    clearStaleExpiryTimer()

    const entries = Object.values(get().agentStatusByPaneKey)
    if (entries.length === 0) {
      return
    }

    const now = Date.now()
    let nextExpiryAt = Number.POSITIVE_INFINITY
    for (const entry of entries) {
      nextExpiryAt = Math.min(nextExpiryAt, entry.updatedAt + AGENT_STATUS_STALE_AFTER_MS)
    }
    if (!Number.isFinite(nextExpiryAt)) {
      return
    }

    const delayMs = Math.max(0, nextExpiryAt - now + 1)
    staleExpiryTimer = setTimeout(() => {
      staleExpiryTimer = null
      // Why: freshness is time-based, not event-based. Advancing this epoch at
      // the exact stale boundary forces all freshness-aware selectors to
      // recompute even when no new PTY output arrives.
      set((s) => ({ agentStatusEpoch: s.agentStatusEpoch + 1 }))
      scheduleNextFreshnessExpiry()
    }, delayMs)
  }

  return {
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    retainedAgentsByPaneKey: {},

    setAgentStatus: (paneKey, payload, terminalTitle) => {
      set((s) => {
        const existing = s.agentStatusByPaneKey[paneKey]
        const effectiveTitle = terminalTitle ?? existing?.terminalTitle

        // Why: build up a rolling log of state transitions so the dashboard can
        // render activity blocks showing what the agent has been doing. Only push
        // when the state actually changes to avoid duplicate entries from prompt-
        // only updates within the same state.
        let history: AgentStateHistoryEntry[] = existing?.stateHistory ?? []
        if (existing && existing.state !== payload.state) {
          history = [
            ...history,
            { state: existing.state, prompt: existing.prompt, startedAt: existing.updatedAt }
          ]
          if (history.length > AGENT_STATE_HISTORY_MAX) {
            history = history.slice(history.length - AGENT_STATE_HISTORY_MAX)
          }
        }

        // Why: tool/assistant fields come pre-merged from the main-process
        // cache (see `resolveToolState` in server.ts), so the payload always
        // carries the authoritative current snapshot — including clears on a
        // fresh turn. Writing through directly (no existing fallback) is what
        // lets a `UserPromptSubmit` reset clear stale tool lines in the UI.
        const entry: AgentStatusEntry = {
          state: payload.state,
          prompt: payload.prompt,
          updatedAt: Date.now(),
          agentType: payload.agentType,
          paneKey,
          terminalTitle: effectiveTitle,
          stateHistory: history,
          toolName: payload.toolName,
          toolInput: payload.toolInput,
          lastAssistantMessage: payload.lastAssistantMessage
        }
        return {
          agentStatusByPaneKey: { ...s.agentStatusByPaneKey, [paneKey]: entry },
          // Why: bump both epochs so WorktreeCard re-derives its visual status
          // and WorktreeList re-sorts immediately when an agent reports status.
          agentStatusEpoch: s.agentStatusEpoch + 1,
          sortEpoch: s.sortEpoch + 1
        }
      })
      // Why: schedule after set completes so the timer reads the updated map.
      // queueMicrotask avoids re-entry into the zustand store during set.
      queueMicrotask(() => scheduleNextFreshnessExpiry())
    },

    removeAgentStatus: (paneKey) => {
      set((s) => {
        if (!(paneKey in s.agentStatusByPaneKey)) {
          return s
        }
        const next = { ...s.agentStatusByPaneKey }
        delete next[paneKey]
        return {
          agentStatusByPaneKey: next,
          agentStatusEpoch: s.agentStatusEpoch + 1
        }
      })
      queueMicrotask(() => scheduleNextFreshnessExpiry())
    },

    removeAgentStatusByTabPrefix: (tabIdPrefix) => {
      set((s) => {
        const prefix = `${tabIdPrefix}:`
        const keys = Object.keys(s.agentStatusByPaneKey)
        const toRemove = keys.filter((k) => k.startsWith(prefix))
        if (toRemove.length === 0) {
          return s
        }
        const next = { ...s.agentStatusByPaneKey }
        for (const key of toRemove) {
          delete next[key]
        }
        return {
          agentStatusByPaneKey: next,
          agentStatusEpoch: s.agentStatusEpoch + 1
        }
      })
      queueMicrotask(() => scheduleNextFreshnessExpiry())
    },

    retainAgent: (retained) => {
      set((s) => ({
        retainedAgentsByPaneKey: {
          ...s.retainedAgentsByPaneKey,
          [retained.entry.paneKey]: retained
        }
      }))
    },

    dismissRetainedAgent: (paneKey) => {
      set((s) => {
        if (!(paneKey in s.retainedAgentsByPaneKey)) {
          return s
        }
        const next = { ...s.retainedAgentsByPaneKey }
        delete next[paneKey]
        return { retainedAgentsByPaneKey: next }
      })
    },

    dismissRetainedAgentsByWorktree: (worktreeId) => {
      set((s) => {
        let changed = false
        const next: Record<string, RetainedAgentEntry> = {}
        for (const [key, ra] of Object.entries(s.retainedAgentsByPaneKey)) {
          if (ra.worktreeId === worktreeId) {
            changed = true
            continue
          }
          next[key] = ra
        }
        return changed ? { retainedAgentsByPaneKey: next } : s
      })
    },

    pruneRetainedAgents: (validWorktreeIds) => {
      set((s) => {
        let changed = false
        const next: Record<string, RetainedAgentEntry> = {}
        for (const [key, ra] of Object.entries(s.retainedAgentsByPaneKey)) {
          if (!validWorktreeIds.has(ra.worktreeId)) {
            changed = true
            continue
          }
          next[key] = ra
        }
        return changed ? { retainedAgentsByPaneKey: next } : s
      })
    }
  }
}
