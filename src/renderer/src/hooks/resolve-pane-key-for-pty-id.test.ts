import { describe, expect, it } from 'vitest'
import { resolvePaneKeyForPtyId } from './useIpcEvents'

type StoreShape = Parameters<typeof resolvePaneKeyForPtyId>[0]

function makeStore(
  terminalLayoutsByTabId: Record<string, { ptyIdsByLeafId?: Record<string, string> }> = {}
): StoreShape {
  // Why: resolvePaneKeyForPtyId only reads `terminalLayoutsByTabId` from the
  // store state. Cast through `unknown` so we don't have to stub every
  // unrelated field on AppState just to exercise this function.
  return { terminalLayoutsByTabId } as unknown as StoreShape
}

describe('resolvePaneKeyForPtyId', () => {
  it('returns the composite paneKey for a tracked ptyId', () => {
    const store = makeStore({
      'tab-1': { ptyIdsByLeafId: { 'pane:3': 'pty-a' } }
    })
    expect(resolvePaneKeyForPtyId(store, 'pty-a')).toBe('tab-1:3')
  })

  it('returns null for an unknown ptyId (no-op on foreground-shell IPC)', () => {
    const store = makeStore({
      'tab-1': { ptyIdsByLeafId: { 'pane:3': 'pty-a' } }
    })
    expect(resolvePaneKeyForPtyId(store, 'pty-missing')).toBeNull()
  })

  it('returns null when no layouts have ptyIdsByLeafId bindings', () => {
    expect(resolvePaneKeyForPtyId(makeStore({}), 'pty-a')).toBeNull()
    expect(resolvePaneKeyForPtyId(makeStore({ 'tab-1': {} }), 'pty-a')).toBeNull()
  })

  it('disambiguates split panes within a single tab', () => {
    const store = makeStore({
      'tab-1': {
        ptyIdsByLeafId: {
          'pane:1': 'pty-left',
          'pane:2': 'pty-right'
        }
      }
    })
    expect(resolvePaneKeyForPtyId(store, 'pty-right')).toBe('tab-1:2')
  })
})
