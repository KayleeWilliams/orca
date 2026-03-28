import { describe, expect, it } from 'vitest'
import { getEditorHeaderCopyState } from './editor-header'
import type { OpenFile } from '@/store/slices/editor'

function makeOpenFile(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: '/repo/file.ts',
    filePath: '/repo/file.ts',
    relativePath: 'file.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    isDirty: false,
    mode: 'edit',
    ...overrides
  }
}

describe('getEditorHeaderCopyState', () => {
  it('shows the absolute file path for normal file tabs', () => {
    expect(getEditorHeaderCopyState(makeOpenFile())).toEqual({
      copyText: '/repo/file.ts',
      copyToastLabel: 'File path copied',
      pathLabel: '/repo/file.ts',
      pathTitle: '/repo/file.ts'
    })
  })

  it('adds a diff suffix to single-file diff headers', () => {
    expect(
      getEditorHeaderCopyState(
        makeOpenFile({
          id: '/repo/file.ts::unstaged',
          mode: 'diff',
          diffStaged: false
        })
      )
    ).toEqual({
      copyText: '/repo/file.ts',
      copyToastLabel: 'File path copied',
      pathLabel: '/repo/file.ts (diff)',
      pathTitle: '/repo/file.ts (diff)'
    })
  })

  it('adds a staged diff suffix to staged diff headers', () => {
    expect(
      getEditorHeaderCopyState(
        makeOpenFile({
          id: '/repo/file.ts::staged',
          mode: 'diff',
          diffStaged: true
        })
      )
    ).toEqual({
      copyText: '/repo/file.ts',
      copyToastLabel: 'File path copied',
      pathLabel: '/repo/file.ts (diff staged)',
      pathTitle: '/repo/file.ts (diff staged)'
    })
  })

  it('shows All Changes while still copying the worktree path', () => {
    expect(
      getEditorHeaderCopyState(
        makeOpenFile({
          id: 'wt-1::all-diffs',
          filePath: '/repo/worktree',
          relativePath: 'All Changes',
          mode: 'diff',
          diffStaged: undefined
        })
      )
    ).toEqual({
      copyText: '/repo/worktree',
      copyToastLabel: 'Worktree path copied',
      pathLabel: 'All Changes',
      pathTitle: '/repo/worktree'
    })
  })
})
