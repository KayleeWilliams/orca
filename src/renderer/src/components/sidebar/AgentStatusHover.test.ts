import { describe, expect, it } from 'vitest'
import { buildAgentStatusHoverRows } from './AgentStatusHover'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/types'

const NOW = new Date('2026-04-09T18:30:00.000Z').getTime()

function makeTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: overrides.id ?? 'tab-1',
    ptyId: overrides.ptyId ?? 'pty-1',
    worktreeId: overrides.worktreeId ?? 'wt-1',
    title: overrides.title ?? 'bash',
    customTitle: overrides.customTitle ?? null,
    color: overrides.color ?? null,
    sortOrder: overrides.sortOrder ?? 0,
    createdAt: overrides.createdAt ?? NOW - 60_000
  }
}

function makeEntry(overrides: Partial<AgentStatusEntry> & { paneKey: string }): AgentStatusEntry {
  return {
    state: overrides.state ?? 'working',
    summary: overrides.summary ?? '',
    next: overrides.next ?? '',
    updatedAt: overrides.updatedAt ?? NOW - 30_000,
    source: overrides.source ?? 'agent',
    agentType: overrides.agentType ?? 'codex',
    paneKey: overrides.paneKey,
    terminalTitle: overrides.terminalTitle,
    stateHistory: overrides.stateHistory ?? []
  }
}

describe('buildAgentStatusHoverRows', () => {
  it('renders one row per explicit pane status in a split tab', () => {
    const rows = buildAgentStatusHoverRows(
      [makeTab({ id: 'tab-1', title: 'codex working' })],
      {
        'tab-1:1': makeEntry({ paneKey: 'tab-1:1', summary: 'Fix login bug' }),
        'tab-1:2': makeEntry({
          paneKey: 'tab-1:2',
          state: 'blocked',
          summary: 'Waiting on failing test'
        })
      },
      NOW
    )

    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.key)).toEqual(['tab-1:2', 'tab-1:1'])
  })

  it('falls back to one heuristic row when a live tab has no explicit status', () => {
    const rows = buildAgentStatusHoverRows([makeTab({ id: 'tab-1', title: 'codex idle' })], {}, NOW)

    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('heuristic')
  })

  it('keeps stale explicit summaries but orders by heuristic urgency', () => {
    const rows = buildAgentStatusHoverRows(
      [
        makeTab({ id: 'tab-a', title: 'codex permission needed' }),
        makeTab({ id: 'tab-b', title: 'codex working' })
      ],
      {
        'tab-a:1': makeEntry({
          paneKey: 'tab-a:1',
          state: 'done',
          updatedAt: NOW - 45 * 60_000
        }),
        'tab-b:1': makeEntry({
          paneKey: 'tab-b:1',
          state: 'done',
          updatedAt: NOW - 45 * 60_000
        })
      },
      NOW
    )

    expect(rows.map((row) => row.key)).toEqual(['tab-a:1', 'tab-b:1'])
  })
})
