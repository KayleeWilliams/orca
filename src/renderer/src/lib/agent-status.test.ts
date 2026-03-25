import { describe, expect, it } from 'vitest'
import { detectAgentStatusFromTitle, clearWorkingIndicators } from './agent-status'

describe('detectAgentStatusFromTitle', () => {
  it('detects permission requests from agent titles', () => {
    expect(detectAgentStatusFromTitle('Claude Code - action required')).toBe('permission')
  })

  it('treats braille spinners as working and Gemini symbols as idle', () => {
    expect(detectAgentStatusFromTitle('⠋ Codex is thinking')).toBe('working')
    expect(detectAgentStatusFromTitle('◇ Gemini CLI')).toBe('idle')
  })
})

describe('clearWorkingIndicators', () => {
  it('strips Claude Code ". " working prefix', () => {
    const cleared = clearWorkingIndicators('. claude')
    expect(cleared).toBe('claude')
    expect(detectAgentStatusFromTitle(cleared)).not.toBe('working')
  })

  it('strips braille spinner characters and working keywords', () => {
    const cleared = clearWorkingIndicators('⠋ Codex is thinking')
    expect(cleared).toBe('Codex is')
    expect(detectAgentStatusFromTitle(cleared)).not.toBe('working')
  })

  it('strips Gemini working symbol', () => {
    const cleared = clearWorkingIndicators('✦ Gemini CLI')
    expect(cleared).toBe('Gemini CLI')
    expect(detectAgentStatusFromTitle(cleared)).not.toBe('working')
  })

  it('returns original title if no working indicators found', () => {
    expect(clearWorkingIndicators('* claude')).toBe('* claude')
    expect(clearWorkingIndicators('Terminal 1')).toBe('Terminal 1')
  })
})
