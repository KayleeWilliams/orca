import { describe, it, expect } from 'vitest'
import {
  createAgentStatusOscProcessor,
  extractAgentStatusOsc,
  stripAgentStatusOsc
} from './pty-transport'

describe('extractAgentStatusOsc', () => {
  it('extracts a valid OSC 9999 payload with BEL terminator', () => {
    const data = '\x1b]9999;{"state":"working","summary":"fixing tests","next":"run CI"}\x07'
    const result = extractAgentStatusOsc(data)
    expect(result).toEqual({
      state: 'working',
      summary: 'fixing tests',
      next: 'run CI'
    })
  })

  it('extracts a valid OSC 9999 payload with ST terminator', () => {
    const data = '\x1b]9999;{"state":"done","summary":"all tests pass"}\x1b\\'
    const result = extractAgentStatusOsc(data)
    expect(result).toEqual({
      state: 'done',
      summary: 'all tests pass',
      next: ''
    })
  })

  it('returns null when no OSC 9999 is present', () => {
    expect(extractAgentStatusOsc('normal terminal output')).toBeNull()
    expect(extractAgentStatusOsc('\x1b]0;window title\x07')).toBeNull()
  })

  it('returns the last valid payload when multiple are present', () => {
    const data =
      '\x1b]9999;{"state":"working","summary":"first"}\x07' +
      'some output' +
      '\x1b]9999;{"state":"blocked","summary":"second"}\x07'
    const result = extractAgentStatusOsc(data)
    expect(result!.state).toBe('blocked')
    expect(result!.summary).toBe('second')
  })

  it('skips malformed JSON payloads', () => {
    const data = '\x1b]9999;{broken json}\x07'
    expect(extractAgentStatusOsc(data)).toBeNull()
  })

  it('handles OSC 9999 mixed with regular output', () => {
    const data =
      'Hello world\x1b]0;shell title\x07more text' +
      '\x1b]9999;{"state":"waiting","summary":"needs input"}\x07' +
      'even more text'
    const result = extractAgentStatusOsc(data)
    expect(result!.state).toBe('waiting')
  })
})

describe('stripAgentStatusOsc', () => {
  it('strips OSC 9999 sequences with BEL terminator', () => {
    const data = 'before\x1b]9999;{"state":"working"}\x07after'
    expect(stripAgentStatusOsc(data)).toBe('beforeafter')
  })

  it('strips OSC 9999 sequences with ST terminator', () => {
    const data = 'before\x1b]9999;{"state":"done"}\x1b\\after'
    expect(stripAgentStatusOsc(data)).toBe('beforeafter')
  })

  it('strips multiple OSC 9999 sequences', () => {
    const data = '\x1b]9999;{"state":"working"}\x07middle\x1b]9999;{"state":"done"}\x07end'
    expect(stripAgentStatusOsc(data)).toBe('middleend')
  })

  it('preserves non-9999 OSC sequences', () => {
    const data = '\x1b]0;window title\x07\x1b]9999;{"state":"working"}\x07'
    expect(stripAgentStatusOsc(data)).toBe('\x1b]0;window title\x07')
  })

  it('returns data unchanged when no OSC 9999 is present', () => {
    const data = 'normal output\x1b]0;title\x07more output'
    expect(stripAgentStatusOsc(data)).toBe(data)
  })
})

describe('createAgentStatusOscProcessor', () => {
  it('reassembles an OSC 9999 payload split across PTY chunks', () => {
    const process = createAgentStatusOscProcessor()

    expect(process('before\x1b]9999;{"state":"working","sum')).toEqual({
      cleanData: 'before',
      payloads: []
    })

    expect(process('mary":"Fix tests","next":"Run CI"}\x07after')).toEqual({
      cleanData: 'after',
      payloads: [
        {
          state: 'working',
          summary: 'Fix tests',
          next: 'Run CI'
        }
      ]
    })
  })

  it('strips malformed OSC 9999 payloads without leaking bytes to the terminal', () => {
    const process = createAgentStatusOscProcessor()

    expect(process('x\x1b]9999;{broken').cleanData).toBe('x')
    expect(process(' json}\x07y')).toEqual({
      cleanData: 'y',
      payloads: []
    })
  })
})
