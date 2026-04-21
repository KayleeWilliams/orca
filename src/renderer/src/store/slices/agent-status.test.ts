import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import { createTestStore } from './store-test-helpers'

// Why: queueMicrotask is used by the agent-status slice to schedule the
// freshness timer after state updates. In tests we need to flush microtasks
// before advancing fake timers so the setTimeout gets registered.
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve))
}

describe('agent status freshness expiry', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('advances agentStatusEpoch when a fresh entry crosses the stale threshold', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-09T12:00:00.000Z'))

    const store = createTestStore()
    store.getState().setAgentStatus('tab-1:1', { state: 'working', prompt: 'Fix tests' }, 'codex')

    // setAgentStatus bumps epoch once synchronously
    expect(store.getState().agentStatusEpoch).toBe(1)

    // Flush the queueMicrotask that schedules the freshness timer
    await flushMicrotasks()

    vi.advanceTimersByTime(AGENT_STATUS_STALE_AFTER_MS + 1)

    // Timer bump adds another increment
    expect(store.getState().agentStatusEpoch).toBe(2)
  })

  it('cancels the scheduled freshness tick when the entry is removed first', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-09T12:00:00.000Z'))

    const store = createTestStore()
    store.getState().setAgentStatus('tab-1:1', { state: 'working', prompt: 'Fix tests' }, 'codex')
    // set bumps to 1, remove bumps to 2
    store.getState().removeAgentStatus('tab-1:1')
    expect(store.getState().agentStatusEpoch).toBe(2)

    // Flush microtask and advance past stale threshold
    await flushMicrotasks()
    vi.advanceTimersByTime(AGENT_STATUS_STALE_AFTER_MS + 1)

    // No additional bump since the entry was removed before the timer fires
    expect(store.getState().agentStatusEpoch).toBe(2)
  })
})

describe('agent status tool + assistant fields', () => {
  it('writes toolName, toolInput, and lastAssistantMessage straight onto the entry', () => {
    const store = createTestStore()
    store.getState().setAgentStatus(
      'tab-1:1',
      {
        state: 'working',
        prompt: 'Edit the config',
        toolName: 'Edit',
        toolInput: '/src/config.ts',
        lastAssistantMessage: 'Edited config.ts'
      },
      'claude'
    )
    const entry = store.getState().agentStatusByPaneKey['tab-1:1']
    expect(entry.toolName).toBe('Edit')
    expect(entry.toolInput).toBe('/src/config.ts')
    expect(entry.lastAssistantMessage).toBe('Edited config.ts')
  })

  it('clears fields to undefined when a later payload omits them', () => {
    const store = createTestStore()
    store.getState().setAgentStatus(
      'tab-1:1',
      {
        state: 'working',
        prompt: 'Edit the config',
        toolName: 'Edit',
        toolInput: '/src/config.ts',
        lastAssistantMessage: 'Edited config.ts'
      },
      'claude'
    )
    // Why: the main-process cache is the source of truth for tool/assistant
    // fields — a fresh-turn reset surfaces as undefined on the payload, and
    // the store must not fall back to the prior entry's values.
    store.getState().setAgentStatus('tab-1:1', { state: 'working', prompt: 'Next step' }, 'claude')
    const entry = store.getState().agentStatusByPaneKey['tab-1:1']
    expect(entry.toolName).toBeUndefined()
    expect(entry.toolInput).toBeUndefined()
    expect(entry.lastAssistantMessage).toBeUndefined()
  })
})
