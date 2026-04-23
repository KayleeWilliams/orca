import { useCallback, useMemo, useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { dirname } from '@/lib/path'
import { getConnectionId } from '@/lib/connection-context'
import { isPathEqualOrDescendant } from './file-explorer-paths'
import type { TreeNode } from './file-explorer-types'
import { requestEditorSaveQuiesce } from '@/components/editor/editor-autosave'
import { commitFileExplorerOp } from './fileExplorerUndoRedo'

type UseFileDeletionParams = {
  activeWorktreeId: string | null
  openFiles: {
    id: string
    filePath: string
  }[]
  closeFile: (fileId: string) => void
  refreshDir: (dirPath: string) => Promise<void>
  selectedPath: string | null
  setSelectedPath: Dispatch<SetStateAction<string | null>>
  isMac: boolean
  isWindows: boolean
}

type UseFileDeletionResult = {
  deleteShortcutLabel: string
  requestDelete: (node: TreeNode) => void
}

export function useFileDeletion({
  activeWorktreeId,
  openFiles,
  closeFile,
  refreshDir,
  selectedPath,
  setSelectedPath,
  isMac,
  isWindows
}: UseFileDeletionParams): UseFileDeletionResult {
  // Why: track in-flight deletes per-path so repeated Del presses on the same
  // node don't issue duplicate IPC calls; the map is a ref to avoid re-renders.
  const inFlightRef = useRef<Set<string>>(new Set())

  const runDelete = useCallback(
    async (node: TreeNode) => {
      if (inFlightRef.current.has(node.path)) {
        return
      }
      inFlightRef.current.add(node.path)

      try {
        const filesToClose = openFiles.filter((file) =>
          isPathEqualOrDescendant(file.filePath, node.path)
        )
        // Why: moving a file to Trash/Recycle Bin is another external mutation of
        // the file path. Let any in-flight autosave finish first so the delete
        // action cannot be undone by a trailing write that recreates the file.
        await Promise.all(filesToClose.map((file) => requestEditorSaveQuiesce({ fileId: file.id })))

        const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined
        const parentDir = dirname(node.path)
        // Why: read file content before deleting so undo can restore it.
        // We capture content first but only commit the undo entry after the
        // delete succeeds — otherwise a failed delete would poison the stack.
        let undoContent: string | undefined
        if (!node.isDirectory) {
          try {
            const rf = await window.api.fs.readFile({ filePath: node.path, connectionId })
            if (!rf.isBinary) {
              undoContent = rf.content
            }
          } catch {
            // If we cannot read the file (race, permission), skip undo recording
            // so a failed undo cannot restore stale content.
          }
        }

        await window.api.fs.deletePath({ targetPath: node.path, connectionId })

        if (undoContent !== undefined) {
          commitFileExplorerOp({
            undo: async () => {
              await window.api.fs.writeFile({
                filePath: node.path,
                content: undoContent,
                connectionId
              })
              await refreshDir(parentDir)
            },
            redo: async () => {
              await window.api.fs.deletePath({ targetPath: node.path, connectionId })
              await refreshDir(parentDir)
            }
          })
        }

        for (const file of filesToClose) {
          closeFile(file.id)
        }

        if (activeWorktreeId) {
          useAppStore.setState((state) => {
            const currentExpanded = state.expandedDirs[activeWorktreeId] ?? new Set<string>()
            const nextExpanded = new Set(
              Array.from(currentExpanded).filter(
                (dirPath) => !isPathEqualOrDescendant(dirPath, node.path)
              )
            )

            if (nextExpanded.size === currentExpanded.size) {
              return state
            }

            return {
              expandedDirs: {
                ...state.expandedDirs,
                [activeWorktreeId]: nextExpanded
              }
            }
          })
        }

        if (selectedPath && isPathEqualOrDescendant(selectedPath, node.path)) {
          setSelectedPath(null)
        }
        // Why: use targeted refreshDir instead of refreshTree so only the parent
        // directory is reloaded, preserving scroll position and avoiding redundant
        // full-tree reloads (the watcher will also trigger a targeted refresh).
        await refreshDir(dirname(node.path))

        const destination = isWindows ? 'Recycle Bin' : 'Trash'
        toast.success(`'${node.name}' moved to ${destination}`)
      } catch (error) {
        const action = isWindows ? 'move to Recycle Bin' : 'move to Trash'
        toast.error(error instanceof Error ? error.message : `Failed to ${action} '${node.name}'.`)
      } finally {
        inFlightRef.current.delete(node.path)
      }
    },
    [activeWorktreeId, closeFile, isWindows, openFiles, refreshDir, selectedPath, setSelectedPath]
  )

  const requestDelete = useCallback(
    (node: TreeNode) => {
      setSelectedPath(node.path)
      // Why: per product decision, skip the confirmation dialog — trashing is
      // reversible (OS-level trash + in-app undo), so the extra prompt is noise.
      void runDelete(node)
    },
    [runDelete, setSelectedPath]
  )

  return useMemo(
    () => ({
      deleteShortcutLabel: isMac ? '⌘⌫ / Del' : 'Del',
      requestDelete
    }),
    [isMac, requestDelete]
  )
}
