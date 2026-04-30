import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MarkdownDocument } from '../../../../shared/types'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { getConnectionId } from '@/lib/connection-context'
import type { MarkdownViewMode, OpenFile } from '@/store/slices/editor'

type UseMarkdownDocumentsResult = {
  markdownDocuments: MarkdownDocument[]
  previewProps: {
    markdownDocuments: MarkdownDocument[]
    onOpenDocument: (document: MarkdownDocument) => Promise<void>
  }
  refreshMarkdownDocuments: () => Promise<void>
}

export function useMarkdownDocuments(
  activeFile: OpenFile,
  isMarkdown: boolean,
  viewMode: MarkdownViewMode
): UseMarkdownDocumentsResult {
  const worktreeId = activeFile.worktreeId
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const openFile = useAppStore((s) => s.openFile)
  const [markdownDocumentsByWorktree, setMarkdownDocumentsByWorktree] = useState<
    Record<string, MarkdownDocument[]>
  >({})
  const requestRef = useRef(0)

  const worktreePath = useMemo(() => {
    if (!worktreeId) {
      return null
    }
    return findWorktreeById(worktreesByRepo, worktreeId)?.path ?? null
  }, [worktreeId, worktreesByRepo])

  const connectionId = getConnectionId(worktreeId)

  const refreshMarkdownDocuments = useCallback(async (): Promise<void> => {
    if (!worktreeId || !worktreePath) {
      return
    }

    const requestId = requestRef.current + 1
    requestRef.current = requestId
    try {
      const documents = await window.api.fs.listMarkdownDocuments({
        rootPath: worktreePath,
        connectionId: connectionId ?? undefined
      })
      if (requestRef.current !== requestId) {
        return
      }
      setMarkdownDocumentsByWorktree((prev) => ({
        ...prev,
        [worktreeId]: documents
      }))
    } catch (err) {
      console.error('Failed to list markdown documents:', err)
      if (requestRef.current === requestId) {
        setMarkdownDocumentsByWorktree((prev) => ({
          ...prev,
          [worktreeId]: []
        }))
      }
    }
  }, [connectionId, worktreeId, worktreePath])

  const openMarkdownDocument = useCallback(
    async (document: MarkdownDocument): Promise<void> => {
      if (!worktreeId) {
        return
      }
      try {
        const stats = await window.api.fs.stat({
          filePath: document.filePath,
          connectionId: connectionId ?? undefined
        })
        if (stats.isDirectory) {
          await refreshMarkdownDocuments()
          return
        }
      } catch {
        await refreshMarkdownDocuments()
        return
      }

      openFile({
        filePath: document.filePath,
        relativePath: document.relativePath,
        worktreeId,
        language: 'markdown',
        mode: 'edit'
      })
    },
    [connectionId, openFile, refreshMarkdownDocuments, worktreeId]
  )

  useEffect(() => {
    if (!isMarkdown) {
      return
    }
    void refreshMarkdownDocuments()
  }, [activeFile.id, isMarkdown, viewMode, refreshMarkdownDocuments])

  const markdownDocuments = worktreeId ? (markdownDocumentsByWorktree[worktreeId] ?? []) : []

  return {
    markdownDocuments,
    previewProps: { markdownDocuments, onOpenDocument: openMarkdownDocument },
    refreshMarkdownDocuments
  }
}
