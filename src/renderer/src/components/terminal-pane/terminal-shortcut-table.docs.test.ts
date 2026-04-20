import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TERMINAL_SHORTCUTS, type ShortcutEntry } from './terminal-shortcut-table'

/**
 * Parity test: the human-readable reference doc at docs/terminal-shortcuts.md
 * must stay in sync with the TERMINAL_SHORTCUTS table. If this test fails,
 * regenerate the MAC/NONMAC tables in the doc by replacing the content
 * between the <!-- BEGIN:X --> / <!-- END:X --> markers with the output
 * printed in the assertion diff.
 */

function formatModifiers(modifiers: readonly string[]): string {
  return modifiers
    .map((m) => {
      if (m === 'mod') {
        return 'Mod'
      }
      if (m === 'ctrl') {
        return 'Ctrl'
      }
      if (m === 'meta') {
        return 'Meta'
      }
      if (m === 'alt') {
        return 'Alt'
      }
      if (m === 'shift') {
        return 'Shift'
      }
      return m
    })
    .join('+')
}

function formatKeyLabel(entry: ShortcutEntry): string {
  const { match } = entry
  if (match.keyLower) {
    return match.keyLower.toUpperCase()
  }
  if (match.key) {
    return match.key
  }
  if (match.code) {
    const codes = typeof match.code === 'string' ? [match.code] : match.code
    const first = codes[0]
    if (first === 'BracketLeft') {
      return '['
    }
    if (first === 'BracketRight') {
      return ']'
    }
    return first
  }
  return '?'
}

function formatChord(entry: ShortcutEntry): string {
  const mods = formatModifiers(entry.match.modifiers)
  const key = formatKeyLabel(entry)
  return mods ? `${mods}+${key}` : key
}

function formatAction(entry: ShortcutEntry): string {
  const a = entry.action
  if (a.type === 'sendInput') {
    return `→ sendInput(${describeBytes(a.data)}) — ${entry.description}`
  }
  return entry.description
}

function describeBytes(data: string): string {
  // Human-readable renderings for the byte sequences we emit, so the doc is
  // scannable without decoding control codes mentally.
  const map: Record<string, string> = {
    '\x01': 'Ctrl+A',
    '\x05': 'Ctrl+E',
    '\x0b': 'Ctrl+K',
    '\x15': 'Ctrl+U',
    '\x17': '\\x17',
    '\x1bb': '\\eb',
    '\x1bf': '\\ef',
    '\x1bd': '\\ed',
    '\x1b\x7f': 'Esc+DEL',
    '\x1b[13;2u': '\\e[13;2u'
  }
  return map[data] ?? JSON.stringify(data)
}

function renderTableRows(forMac: boolean): string[] {
  return TERMINAL_SHORTCUTS.filter((e) => (forMac ? e.mac : e.nonMac)).map(
    (e) => `| \`${formatChord(e)}\` | ${formatAction(e)} |`
  )
}

function extractSection(doc: string, marker: string): string[] {
  const begin = `<!-- BEGIN:${marker} -->`
  const end = `<!-- END:${marker} -->`
  const start = doc.indexOf(begin)
  const stop = doc.indexOf(end)
  if (start === -1 || stop === -1) {
    throw new Error(`Missing ${marker} markers in terminal-shortcuts.md`)
  }
  return doc
    .slice(start + begin.length, stop)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

describe('terminal-shortcuts.md parity with TERMINAL_SHORTCUTS', () => {
  // __dirname-equivalent for this test: five levels up to repo root.
  const docPath = join(__dirname, '..', '..', '..', '..', '..', 'docs', 'terminal-shortcuts.md')

  const doc = readFileSync(docPath, 'utf8')

  it('mac table matches the TERMINAL_SHORTCUTS entries where mac=true', () => {
    const expected = renderTableRows(true)
    const actual = extractSection(doc, 'MAC')
    expect(actual).toEqual(expected)
  })

  it('non-mac table matches the TERMINAL_SHORTCUTS entries where nonMac=true', () => {
    const expected = renderTableRows(false)
    const actual = extractSection(doc, 'NONMAC')
    expect(actual).toEqual(expected)
  })
})
