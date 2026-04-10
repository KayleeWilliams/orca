import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry,
  type AgentStatusOscPayload
} from '../../../../shared/agent-status-types'
import { inferAgentTypeFromTitle } from '@/lib/agent-status'

export type AgentStatusSlice = {
  /** Explicit agent status entries keyed by `${tabId}:${paneId}` composite.
   *  Real-time only — lives in renderer memory, not persisted to disk. */
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  /** Monotonic tick that advances when agent-status freshness boundaries pass. */
  agentStatusEpoch: number

  /** Update or insert an agent status entry from an OSC 9999 payload. */
  setAgentStatus: (paneKey: string, payload: AgentStatusOscPayload, terminalTitle?: string) => void

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
        const entry: AgentStatusEntry = {
          state: payload.state,
          summary: payload.summary ?? '',
          next: payload.next ?? '',
          updatedAt: Date.now(),
          source: 'agent',
          // Why: the design doc requires agentType in the hover, but the OSC
          // payload may omit it. Fall back to title inference so older injected
          // prompts still populate the hover without requiring a coordinated
          // rollout across every agent integration.
          agentType: payload.agentType ?? inferAgentTypeFromTitle(effectiveTitle),
          paneKey,
          terminalTitle: effectiveTitle
        }
        return {
          agentStatusByPaneKey: { ...s.agentStatusByPaneKey, [paneKey]: entry }
        }
      })
      scheduleNextFreshnessExpiry()
    },

    removeAgentStatus: (paneKey) => {
      set((s) => {
        if (!(paneKey in s.agentStatusByPaneKey)) {
          return s
        }
        const next = { ...s.agentStatusByPaneKey }
        delete next[paneKey]
        return { agentStatusByPaneKey: next }
      })
      scheduleNextFreshnessExpiry()
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
        return { agentStatusByPaneKey: next }
      })
      scheduleNextFreshnessExpiry()
    }
  }
}
