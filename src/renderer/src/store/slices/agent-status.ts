import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  AGENT_STATE_HISTORY_MAX,
  type AgentStateHistoryEntry,
  type AgentStatusEntry,
  type ParsedAgentStatusPayload
} from '../../../../shared/agent-status-types'
import { inferAgentTypeFromTitle } from '@/lib/agent-status'

export type AgentStatusSlice = {
  /** Explicit agent status entries keyed by `${tabId}:${paneId}` composite.
   *  Real-time only — lives in renderer memory, not persisted to disk. */
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  /** Monotonic tick that advances when agent-status freshness boundaries pass. */
  agentStatusEpoch: number

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

    setAgentStatus: (paneKey, payload, terminalTitle) => {
      set((s) => {
        const existing = s.agentStatusByPaneKey[paneKey]
        const effectiveTitle = terminalTitle ?? existing?.terminalTitle

        // Why: build up a rolling log of state transitions so the dashboard can
        // render activity blocks showing what the agent has been doing. Only push
        // when the state actually changes to avoid duplicate entries from summary-
        // only updates within the same state.
        let history: AgentStateHistoryEntry[] = existing?.stateHistory ?? []
        if (existing && existing.state !== payload.state) {
          history = [
            ...history,
            { state: existing.state, summary: existing.summary, startedAt: existing.updatedAt }
          ]
          if (history.length > AGENT_STATE_HISTORY_MAX) {
            history = history.slice(history.length - AGENT_STATE_HISTORY_MAX)
          }
        }

        const entry: AgentStatusEntry = {
          state: payload.state,
          summary: payload.summary,
          next: payload.next,
          updatedAt: Date.now(),
          source: 'agent',
          // Why: the design doc requires agentType in the hover, but the OSC
          // payload may omit it. Fall back to title inference so older injected
          // prompts still populate the hover without requiring a coordinated
          // rollout across every agent integration.
          agentType: payload.agentType ?? inferAgentTypeFromTitle(effectiveTitle),
          paneKey,
          terminalTitle: effectiveTitle,
          stateHistory: history
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
    }
  }
}
