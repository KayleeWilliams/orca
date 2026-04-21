import { describe, it, expect } from 'vitest'
import { parseAgentStatusPayload, AGENT_STATUS_MAX_FIELD_LENGTH } from './agent-status-types'

describe('parseAgentStatusPayload', () => {
  it('parses a valid working payload', () => {
    const result = parseAgentStatusPayload(
      '{"state":"working","prompt":"Fix the flaky assertion","agentType":"codex"}'
    )
    expect(result).toEqual({
      state: 'working',
      prompt: 'Fix the flaky assertion',
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

  it('normalizes multiline prompt to single line', () => {
    const result = parseAgentStatusPayload(
      '{"state":"working","prompt":"line one\\nline two\\nline three"}'
    )
    expect(result!.prompt).toBe('line one line two line three')
  })

  it('normalizes Windows-style line endings (\\r\\n) to single line', () => {
    const result = parseAgentStatusPayload(
      '{"state":"working","prompt":"line one\\r\\nline two\\r\\nline three"}'
    )
    expect(result!.prompt).toBe('line one line two line three')
  })

  it('trims whitespace from the prompt field', () => {
    const result = parseAgentStatusPayload('{"state":"working","prompt":"  padded  "}')
    expect(result!.prompt).toBe('padded')
  })

  it('truncates the prompt beyond max length', () => {
    const longString = 'x'.repeat(300)
    const result = parseAgentStatusPayload(`{"state":"working","prompt":"${longString}"}`)
    expect(result!.prompt).toHaveLength(AGENT_STATUS_MAX_FIELD_LENGTH)
  })

  it('defaults missing prompt to empty string', () => {
    const result = parseAgentStatusPayload('{"state":"done"}')
    expect(result!.prompt).toBe('')
  })

  it('handles non-string prompt gracefully', () => {
    const result = parseAgentStatusPayload('{"state":"working","prompt":42}')
    expect(result!.prompt).toBe('')
  })

  it('accepts custom non-empty agentType values', () => {
    const result = parseAgentStatusPayload('{"state":"working","agentType":"cursor"}')
    expect(result).toEqual({
      state: 'working',
      prompt: '',
      agentType: 'cursor'
    })
  })
})
