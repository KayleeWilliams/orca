import { describe, expect, it } from 'vitest'
import { getTerminalPaneSearchEntries } from './terminal-search'

describe('getTerminalPaneSearchEntries', () => {
  it('includes the Windows right-click setting on Windows', () => {
    const entries = getTerminalPaneSearchEntries(true)
    expect(entries.some((entry) => entry.title === 'Right-click to paste')).toBe(true)
  })

  it('omits the Windows right-click setting elsewhere', () => {
    const entries = getTerminalPaneSearchEntries(false)
    expect(entries.some((entry) => entry.title === 'Right-click to paste')).toBe(false)
  })
})
