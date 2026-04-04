import { useEffect } from 'react'
import { detectLanguage } from '@/lib/language-detect'
import { isPathInsideWorktree, toWorktreeRelativePath } from '@/lib/terminal-links'
import { useAppStore } from '@/store'

export function useGlobalFileDrop(): void {
  useEffect(() => {
    return window.api.ui.onFileDrop(({ path: filePath }) => {
      const store = useAppStore.getState()
      const activeWorktreeId = store.activeWorktreeId
      if (!activeWorktreeId) {
        return
      }

      const activeWorktree = store.allWorktrees().find((w) => w.id === activeWorktreeId)
      const worktreePath = activeWorktree?.path

      void (async () => {
        try {
          await window.api.fs.authorizeExternalPath({ targetPath: filePath })
          const stat = await window.api.fs.stat({ filePath })
          if (stat.isDirectory) {
            return
          }

          let relativePath = filePath
          if (worktreePath && isPathInsideWorktree(filePath, worktreePath)) {
            const maybeRelative = toWorktreeRelativePath(filePath, worktreePath)
            if (maybeRelative !== null && maybeRelative.length > 0) {
              relativePath = maybeRelative
            }
          }

          // Why: native OS file drops are resolved in preload because the
          // isolated renderer cannot read filesystem paths from File objects.
          // App owns those external drops so they consistently open in the
          // editor instead of being misrouted to whichever terminal is active.
          store.setActiveTabType('editor')
          store.openFile({
            filePath,
            relativePath,
            worktreeId: activeWorktreeId,
            language: detectLanguage(filePath),
            mode: 'edit'
          })
        } catch {
          // Ignore files that cannot be authorized or stat'd.
        }
      })()
    })
  }, [])
}
