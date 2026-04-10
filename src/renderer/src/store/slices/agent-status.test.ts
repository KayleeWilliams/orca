import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import { createTestStore } from './store-test-helpers'

describe('agent status freshness expiry', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('advances agentStatusEpoch when a fresh entry crosses the stale threshold', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-09T12:00:00.000Z'))

    const store = createTestStore()
    store.getState().setAgentStatus('tab-1:1', { state: 'working', summary: 'Fix tests' }, 'codex')

    expect(store.getState().agentStatusEpoch).toBe(0)

    vi.advanceTimersByTime(AGENT_STATUS_STALE_AFTER_MS + 1)

    expect(store.getState().agentStatusEpoch).toBe(1)
  })

  it('cancels the scheduled freshness tick when the entry is removed first', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-09T12:00:00.000Z'))

    const store = createTestStore()
    store.getState().setAgentStatus('tab-1:1', { state: 'working', summary: 'Fix tests' }, 'codex')
    store.getState().removeAgentStatus('tab-1:1')

    vi.advanceTimersByTime(AGENT_STATUS_STALE_AFTER_MS + 1)

    expect(store.getState().agentStatusEpoch).toBe(0)
  })
})
