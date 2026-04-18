import { describe, expect, it } from 'vitest'
import { getWorktreeStatus, getWorktreeStatusLabel } from './worktree-status'

describe('worktree-status', () => {
  it('prioritizes permission over other live activity states', () => {
    const status = getWorktreeStatus(
      [
        { id: 'tab-1', ptyId: 'pty-working', title: 'claude [working]' },
        { id: 'tab-2', ptyId: 'pty-permission', title: 'claude [permission]' }
      ],
      [{ id: 'browser-1' }]
    )

    expect(status).toBe('permission')
    expect(getWorktreeStatusLabel(status)).toBe('Needs permission')
  })

  it('treats browser-only worktrees as active', () => {
    const status = getWorktreeStatus([], [{ id: 'browser-1' }])

    expect(status).toBe('active')
  })

  it('returns inactive when neither tabs nor browser state are live', () => {
    expect(getWorktreeStatus([], [])).toBe('inactive')
  })

  it('returns inactive when tab.ptyId is stale but the PTY map says dead', () => {
    const status = getWorktreeStatus([{ id: 'tab-1', ptyId: 'stale-pty', title: 'shell' }], [], {
      'tab-1': []
    })

    expect(status).toBe('inactive')
  })
})
