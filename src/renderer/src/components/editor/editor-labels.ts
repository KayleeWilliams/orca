import type { OpenFile } from '@/store/slices/editor'
import { basename } from '@/lib/path'

type EditorLabelVariant = 'fileName' | 'relativePath' | 'fullPath'

function getBaseLabel(file: OpenFile, variant: EditorLabelVariant): string {
  if (file.mode === 'diff' && file.diffStaged === undefined) {
    return file.relativePath
  }

  switch (variant) {
    case 'fullPath':
      return file.filePath
    case 'relativePath':
      return file.relativePath
    case 'fileName':
      return basename(file.relativePath)
  }
}

function getDiffSuffix(file: OpenFile): string | null {
  if (file.mode !== 'diff' || file.diffStaged === undefined) {
    return null
  }

  return file.diffStaged ? 'diff staged' : 'diff'
}

export function getEditorDisplayLabel(
  file: OpenFile,
  variant: EditorLabelVariant = 'fileName'
): string {
  const baseLabel = getBaseLabel(file, variant)
  const diffSuffix = getDiffSuffix(file)

  return diffSuffix ? `${baseLabel} (${diffSuffix})` : baseLabel
}
