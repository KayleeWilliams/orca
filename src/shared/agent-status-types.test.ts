import { describe, it, expect } from 'vitest'
import {
  parseAgentStatusPayload,
  AGENT_STATUS_MAX_FIELD_LENGTH,
  AGENT_STATUS_TOOL_NAME_MAX_LENGTH,
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH
} from './agent-status-types'

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

  it('parses toolName, toolInput, and lastAssistantMessage', () => {
    const result = parseAgentStatusPayload(
      JSON.stringify({
        state: 'working',
        toolName: 'Edit',
        toolInput: '/path/to/file.ts',
        lastAssistantMessage: 'Here is the edit I made.'
      })
    )
    expect(result).toEqual({
      state: 'working',
      prompt: '',
      agentType: undefined,
      toolName: 'Edit',
      toolInput: '/path/to/file.ts',
      lastAssistantMessage: 'Here is the edit I made.'
    })
  })

  it('truncates each optional field to its own cap', () => {
    const longName = 'n'.repeat(AGENT_STATUS_TOOL_NAME_MAX_LENGTH + 50)
    const longInput = 'i'.repeat(AGENT_STATUS_TOOL_INPUT_MAX_LENGTH + 50)
    const longMessage = 'm'.repeat(AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH + 500)
    const result = parseAgentStatusPayload(
      JSON.stringify({
        state: 'working',
        toolName: longName,
        toolInput: longInput,
        lastAssistantMessage: longMessage
      })
    )
    expect(result!.toolName).toHaveLength(AGENT_STATUS_TOOL_NAME_MAX_LENGTH)
    expect(result!.toolInput).toHaveLength(AGENT_STATUS_TOOL_INPUT_MAX_LENGTH)
    expect(result!.lastAssistantMessage).toHaveLength(AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH)
  })

  it('leaves omitted optional fields undefined (not empty string)', () => {
    const result = parseAgentStatusPayload('{"state":"working"}')
    expect(result!.toolName).toBeUndefined()
    expect(result!.toolInput).toBeUndefined()
    expect(result!.lastAssistantMessage).toBeUndefined()
  })

  it('treats non-string optional fields as undefined', () => {
    const result = parseAgentStatusPayload(
      '{"state":"working","toolName":42,"toolInput":null,"lastAssistantMessage":[]}'
    )
    expect(result!.toolName).toBeUndefined()
    expect(result!.toolInput).toBeUndefined()
    expect(result!.lastAssistantMessage).toBeUndefined()
  })

  it('treats empty-string optional fields as undefined', () => {
    const result = parseAgentStatusPayload(
      '{"state":"working","toolName":"   ","toolInput":"","lastAssistantMessage":"   "}'
    )
    expect(result!.toolName).toBeUndefined()
    expect(result!.toolInput).toBeUndefined()
    expect(result!.lastAssistantMessage).toBeUndefined()
  })

  it('collapses newlines in toolInput (single-line preview field)', () => {
    const result = parseAgentStatusPayload('{"state":"working","toolInput":"line one\\nline two"}')
    expect(result!.toolInput).toBe('line one line two')
  })

  it('preserves paragraph breaks in lastAssistantMessage', () => {
    // Why: the assistant message is rendered with `whitespace-pre-wrap` in the
    // dashboard row so the user sees the same paragraph structure the agent
    // produced. Collapsing newlines would destroy that structure.
    const result = parseAgentStatusPayload(
      '{"state":"done","lastAssistantMessage":"Summary line.\\n\\nDetails paragraph."}'
    )
    expect(result!.lastAssistantMessage).toBe('Summary line.\n\nDetails paragraph.')
  })

  it('normalizes \\r\\n to \\n and caps blank-line runs at one in lastAssistantMessage', () => {
    const result = parseAgentStatusPayload(
      '{"state":"done","lastAssistantMessage":"a\\r\\nb\\n\\n\\n\\nc"}'
    )
    expect(result!.lastAssistantMessage).toBe('a\nb\n\nc')
  })

  it('still respects the base prompt cap independent of the new fields', () => {
    const prompt = 'p'.repeat(300)
    const result = parseAgentStatusPayload(
      JSON.stringify({ state: 'working', prompt, toolInput: 'x'.repeat(5) })
    )
    expect(result!.prompt).toHaveLength(AGENT_STATUS_MAX_FIELD_LENGTH)
    expect(result!.toolInput).toBe('xxxxx')
  })
})
