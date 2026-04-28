import { describe, it, expect } from 'vitest'
import { classifyInputSourceId } from './input-source-id'

describe('classifyInputSourceId', () => {
  it('returns "none" for nullish input (no signal available)', () => {
    expect(classifyInputSourceId(null)).toBe('none')
    expect(classifyInputSourceId(undefined)).toBe('none')
    expect(classifyInputSourceId('')).toBe('none')
  })

  it('returns "none" for plain US QWERTY (fingerprint is authoritative)', () => {
    expect(classifyInputSourceId('com.apple.keylayout.US')).toBe('none')
    expect(classifyInputSourceId('com.apple.keylayout.ABC')).toBe('none')
    expect(classifyInputSourceId('com.apple.keylayout.Dvorak')).toBe('none')
  })

  it('flags Polish Pro as composing (the #1205 repro)', () => {
    expect(classifyInputSourceId('com.apple.keylayout.PolishPro')).toBe('compose')
  })

  it('flags US Extended as composing', () => {
    expect(classifyInputSourceId('com.apple.keylayout.USExtended')).toBe('compose')
  })

  it('flags ABC Extended as composing', () => {
    expect(classifyInputSourceId('com.apple.keylayout.ABCExtended')).toBe('compose')
  })

  it('is case-insensitive (defaults can differ between major macOS versions)', () => {
    expect(classifyInputSourceId('COM.APPLE.KEYLAYOUT.POLISHPRO')).toBe('compose')
    expect(classifyInputSourceId('com.apple.keylayout.polishpro')).toBe('compose')
  })

  it('matches prefix + dot-suffix variants so future Apple-shipped subtypes still flag', () => {
    expect(classifyInputSourceId('com.apple.keylayout.PolishPro.variant')).toBe('compose')
    expect(classifyInputSourceId('com.apple.keylayout.USExtended.v2')).toBe('compose')
  })

  it('does not flag unrelated IDs that happen to start with "com.apple.keylayout.US"', () => {
    // "US" is a prefix of "USExtended"/"USInternational" but on its own it
    // is plain US QWERTY — the denylist uses full-identifier matching plus
    // a `.`-bounded prefix form so "US" never bleeds into variants.
    expect(classifyInputSourceId('com.apple.keylayout.US')).toBe('none')
    expect(classifyInputSourceId('com.apple.keylayout.USInternational-PC')).toBe('none')
  })

  it('flags Japanese/Chinese/Korean Roman IMEs (Option routes through the IME)', () => {
    expect(classifyInputSourceId('com.apple.inputmethod.Kotoeri.Roman')).toBe('compose')
    expect(classifyInputSourceId('com.apple.inputmethod.TCIM.Pinyin')).toBe('compose')
    expect(classifyInputSourceId('com.apple.inputmethod.SCIM.ITABC')).toBe('compose')
    expect(classifyInputSourceId('com.apple.inputmethod.Korean.2SetKorean')).toBe('compose')
  })
})
