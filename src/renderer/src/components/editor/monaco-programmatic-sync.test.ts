import { afterEach, describe, expect, it } from 'vitest'
import {
  beginProgrammaticContentSync,
  endProgrammaticContentSync,
  resetProgrammaticContentSyncForTests,
  shouldIgnoreMonacoContentChange
} from './monaco-programmatic-sync'

afterEach(() => {
  resetProgrammaticContentSyncForTests()
})

describe('shouldIgnoreMonacoContentChange', () => {
  it('ignores echoed shared-model changes in the sibling split pane', () => {
    const filePath = '/repo/seed.spec.ts'
    const syncedContent = 'const answer = 42\n'

    beginProgrammaticContentSync(filePath)
    try {
      expect(
        shouldIgnoreMonacoContentChange({
          filePath,
          value: syncedContent,
          propContent: syncedContent,
          isApplyingProgrammaticContent: false
        })
      ).toBe(true)
    } finally {
      endProgrammaticContentSync(filePath)
    }
  })

  it('ignores local programmatic sync even without a sibling pane', () => {
    expect(
      shouldIgnoreMonacoContentChange({
        filePath: '/repo/seed.spec.ts',
        value: 'updated\n',
        propContent: 'updated\n',
        isApplyingProgrammaticContent: true
      })
    ).toBe(true)
  })

  it('does not ignore a real user edit once programmatic sync is finished', () => {
    expect(
      shouldIgnoreMonacoContentChange({
        filePath: '/repo/seed.spec.ts',
        value: 'user edit\n',
        propContent: 'saved\n',
        isApplyingProgrammaticContent: false
      })
    ).toBe(false)
  })
})
