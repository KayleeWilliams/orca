import { describe, it, expect } from 'vitest'
import { parseAgentStatusPayload, AGENT_STATUS_MAX_FIELD_LENGTH } from './agent-status-types'

describe('parseAgentStatusPayload', () => {
  it('parses a valid working payload', () => {
    const result = parseAgentStatusPayload(
      '{"state":"working","summary":"Investigating test failures","next":"Fix the flaky assertion","agentType":"codex"}'
    )
    expect(result).toEqual({
      state: 'working',
      summary: 'Investigating test failures',
      next: 'Fix the flaky assertion',
      agentType: 'codex'
    })
  })

  it('parses all valid states', () => {
    for (const state of ['working', 'blocked', 'waiting', 'done'] as const) {
      const result = parseAgentStatusPayload(`{"state":"${state}"}`)
      expect(result).not.toBeNull()
      expect(result!.state).toBe(state)
    }
  })

  it('returns null for invalid state', () => {
    expect(parseAgentStatusPayload('{"state":"running"}')).toBeNull()
    expect(parseAgentStatusPayload('{"state":"idle"}')).toBeNull()
    expect(parseAgentStatusPayload('{"state":""}')).toBeNull()
  })

  it('returns null when state is a non-string type', () => {
    expect(parseAgentStatusPayload('{"state":123}')).toBeNull()
    expect(parseAgentStatusPayload('{"state":true}')).toBeNull()
    expect(parseAgentStatusPayload('{"state":null}')).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    expect(parseAgentStatusPayload('not json')).toBeNull()
    expect(parseAgentStatusPayload('{broken')).toBeNull()
    expect(parseAgentStatusPayload('')).toBeNull()
  })

  it('returns null for non-object JSON', () => {
    expect(parseAgentStatusPayload('"just a string"')).toBeNull()
    expect(parseAgentStatusPayload('42')).toBeNull()
    expect(parseAgentStatusPayload('null')).toBeNull()
    expect(parseAgentStatusPayload('[]')).toBeNull()
  })

  it('normalizes multiline summary to single line', () => {
    const result = parseAgentStatusPayload(
      '{"state":"working","summary":"line one\\nline two\\nline three"}'
    )
    expect(result!.summary).toBe('line one line two line three')
  })

  it('normalizes Windows-style line endings (\\r\\n) to single line', () => {
    const result = parseAgentStatusPayload(
      '{"state":"working","summary":"line one\\r\\nline two\\r\\nline three"}'
    )
    expect(result!.summary).toBe('line one line two line three')
  })

  it('trims whitespace from fields', () => {
    const result = parseAgentStatusPayload(
      '{"state":"working","summary":"  padded  ","next":"  also padded  "}'
    )
    expect(result!.summary).toBe('padded')
    expect(result!.next).toBe('also padded')
  })

  it('truncates fields beyond max length', () => {
    const longString = 'x'.repeat(300)
    const result = parseAgentStatusPayload(`{"state":"working","summary":"${longString}"}`)
    expect(result!.summary).toHaveLength(AGENT_STATUS_MAX_FIELD_LENGTH)
  })

  it('defaults missing summary and next to empty string', () => {
    const result = parseAgentStatusPayload('{"state":"done"}')
    expect(result!.summary).toBe('')
    expect(result!.next).toBe('')
  })

  it('handles non-string summary/next gracefully', () => {
    const result = parseAgentStatusPayload('{"state":"working","summary":42,"next":true}')
    expect(result!.summary).toBe('')
    expect(result!.next).toBe('')
  })

  it('accepts custom non-empty agentType values', () => {
    const result = parseAgentStatusPayload('{"state":"working","agentType":"cursor"}')
    expect(result).toEqual({
      state: 'working',
      summary: '',
      next: '',
      agentType: 'cursor'
    })
  })
})
