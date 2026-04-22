import { describe, expect, it } from 'vitest'
import {
  parseOsc7Path,
  parseOsc133Payload,
  pushSemanticMark,
  SEMANTIC_MARK_RING_CAPACITY,
  type RecordedSemanticMark
} from './shell-integration'

describe('parseOsc7Path', () => {
  it('extracts the path from a standard file:// URI', () => {
    expect(parseOsc7Path('file://host/Users/alice/code')).toBe('/Users/alice/code')
  })

  it('ignores the host segment on Unix', () => {
    expect(parseOsc7Path('file://remote.example.com/home/bob')).toBe('/home/bob')
  })

  it('percent-decodes encoded characters', () => {
    expect(parseOsc7Path('file:///Users/alice/my%20project/src')).toBe(
      '/Users/alice/my project/src'
    )
  })

  it('percent-decodes unicode codepoints', () => {
    expect(parseOsc7Path('file:///Users/alice/caf%C3%A9')).toBe('/Users/alice/café')
  })

  it('returns null for empty input', () => {
    expect(parseOsc7Path('')).toBeNull()
  })

  it('returns null for non-file scheme', () => {
    expect(parseOsc7Path('https://example.com/foo')).toBeNull()
  })

  it('returns null for malformed URIs', () => {
    expect(parseOsc7Path('not a uri at all')).toBeNull()
  })
})

describe('parseOsc133Payload', () => {
  it('maps A to prompt-start', () => {
    expect(parseOsc133Payload('A')).toEqual({ kind: 'prompt-start' })
  })

  it('maps B to prompt-end', () => {
    expect(parseOsc133Payload('B')).toEqual({ kind: 'prompt-end' })
  })

  it('maps C to command-end', () => {
    expect(parseOsc133Payload('C')).toEqual({ kind: 'command-end' })
  })

  it('maps bare D to done with no exit code', () => {
    expect(parseOsc133Payload('D')).toEqual({ kind: 'done', exitCode: null })
  })

  it('maps D;0 to done with exit code 0', () => {
    expect(parseOsc133Payload('D;0')).toEqual({ kind: 'done', exitCode: 0 })
  })

  it('maps D;127 to done with exit code 127', () => {
    expect(parseOsc133Payload('D;127')).toEqual({ kind: 'done', exitCode: 127 })
  })

  it('ignores key=value hints after the leading letter', () => {
    // iTerm emits things like A;cl=m to signal the prompt kind — we don't
    // consume the hint today, but must not crash on it.
    expect(parseOsc133Payload('A;cl=m')).toEqual({ kind: 'prompt-start' })
  })

  it('ignores extra hints after the exit code on D', () => {
    expect(parseOsc133Payload('D;0;cl=m')).toEqual({ kind: 'done', exitCode: 0 })
  })

  it('returns null for unknown letters', () => {
    expect(parseOsc133Payload('Z')).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(parseOsc133Payload('')).toBeNull()
  })

  it('returns null exit code when the token is not numeric', () => {
    expect(parseOsc133Payload('D;oops')).toEqual({ kind: 'done', exitCode: null })
  })
})

describe('pushSemanticMark ring buffer', () => {
  it('appends marks under the capacity limit', () => {
    const marks: RecordedSemanticMark[] = []
    pushSemanticMark(marks, { kind: 'prompt-start', row: 1 })
    pushSemanticMark(marks, { kind: 'command-end', row: 5 })
    expect(marks).toHaveLength(2)
    expect(marks[0].row).toBe(1)
    expect(marks[1].row).toBe(5)
  })

  it('evicts oldest marks once past capacity', () => {
    const marks: RecordedSemanticMark[] = []
    const cap = 3
    for (let i = 0; i < 5; i++) {
      pushSemanticMark(marks, { kind: 'prompt-start', row: i }, cap)
    }
    expect(marks).toHaveLength(3)
    expect(marks.map((m) => m.row)).toEqual([2, 3, 4])
  })

  it('uses a sensible default capacity', () => {
    // Why: the cap exists to bound long-running-session memory. The exact
    // number is a product choice, not a correctness invariant — but it
    // must be positive and at least large enough for a realistic day's
    // worth of commands.
    expect(SEMANTIC_MARK_RING_CAPACITY).toBeGreaterThanOrEqual(1_000)
  })
})
