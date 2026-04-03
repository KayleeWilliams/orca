import { useEffect } from 'react'
import { detectLanguage } from '@/lib/language-detect'
import { isPathInsideWorktree, toWorktreeRelativePath } from '@/lib/terminal-links'
import { useAppStore } from '@/store'

export function useGlobalFileDrop(): void {
  useEffect(() => {
    const handleDragOver = (e: DragEvent): void => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault()
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'copy'
        }
      }
    }

    const handleDrop = (e: DragEvent): void => {
      if (!e.dataTransfer?.types.includes('Files')) {
        return
      }
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return
      }
      e.preventDefault()

      const files = Array.from(e.dataTransfer.files)
      if (files.length === 0) {
        return
      }

      const store = useAppStore.getState()
      const activeWorktreeId = store.activeWorktreeId
      if (!activeWorktreeId) {
        return
      }

      const activeWorktree = store.allWorktrees().find((w) => w.id === activeWorktreeId)
      const worktreePath = activeWorktree?.path

      void (async () => {
        for (const file of files) {
          const filePath = (file as unknown as { path?: string }).path
          if (!filePath) {
            continue
          }

          try {
            const stat = await window.api.fs.stat({ filePath })
            if (stat.isDirectory) {
              continue
            }

            let relativePath = filePath
            if (worktreePath && isPathInsideWorktree(filePath, worktreePath)) {
              const maybeRelative = toWorktreeRelativePath(filePath, worktreePath)
              if (maybeRelative !== null && maybeRelative.length > 0) {
                relativePath = maybeRelative
              }
            }

            store.setActiveTabType('editor')
            store.openFile({
              filePath,
              relativePath,
              worktreeId: activeWorktreeId,
              language: detectLanguage(filePath),
              mode: 'edit'
            })
          } catch {
            // Ignore files that can't be stat'd (e.g., they don't exist)
          }
        }
      })()
    }

    window.addEventListener('dragover', handleDragOver)
    window.addEventListener('drop', handleDrop)
    return () => {
      window.removeEventListener('dragover', handleDragOver)
      window.removeEventListener('drop', handleDrop)
    }
  }, [])
}
