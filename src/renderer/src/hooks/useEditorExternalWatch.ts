import { useEffect, useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import { normalizeAbsolutePath } from '@/components/right-sidebar/file-explorer-paths'
import { getExternalFileChangeRelativePath } from '@/components/right-sidebar/useFileExplorerWatch'
import {
  getOpenFilesForExternalFileChange,
  notifyEditorExternalFileChange
} from '@/components/editor/editor-autosave'
import type { FsChangedPayload } from '../../../shared/types'
import { findWorktreeById } from '@/store/slices/worktree-helpers'

type WatchedTarget = {
  worktreeId: string
  worktreePath: string
  connectionId: string | undefined
}

function buildWatchTargets(): WatchedTarget[] {
  const state = useAppStore.getState()
  const worktreeIds = new Set<string>()
  // Why: watch every worktree that has an editor tab open, so terminal edits
  // in any of those roots reach the editor. Also watch the active worktree
  // even when it has no open files — otherwise the File Explorer's tree
  // reconciliation loses its event stream the moment the last tab for that
  // worktree is closed.
  for (const file of state.openFiles) {
    worktreeIds.add(file.worktreeId)
  }
  if (state.activeWorktreeId) {
    worktreeIds.add(state.activeWorktreeId)
  }
  const targets: WatchedTarget[] = []
  for (const worktreeId of worktreeIds) {
    const worktree = findWorktreeById(state.worktreesByRepo, worktreeId)
    if (!worktree) {
      continue
    }
    targets.push({
      worktreeId,
      worktreePath: worktree.path,
      connectionId: getConnectionId(worktreeId) ?? undefined
    })
  }
  return targets
}

/**
 * Subscribes to filesystem watcher events for every worktree that currently
 * has an editor tab open, and notifies the editor to reload clean tabs when
 * their on-disk contents change.
 *
 * Why: the File Explorer panel's watcher hook is unmounted whenever the user
 * switches the right sidebar to Source Control / Checks / Search. Relying on
 * that panel to dispatch editor-reload notifications means terminal edits go
 * unnoticed while any non-Explorer sidebar tab is active. Lifting the
 * editor-reload subscription to an always-mounted hook mirrors VSCode's
 * `TextFileEditorModelManager`, which subscribes to `fileService
 * .onDidFilesChange` once at the workbench level and reloads non-dirty models
 * regardless of which UI panel is visible.
 */
export function useEditorExternalWatch(): void {
  const openFiles = useAppStore((s) => s.openFiles)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)

  // Derive the unique set of (worktreeId, worktreePath) pairs that need a
  // subscription. Keyed by worktreeId so the effect only re-runs when the
  // set of watched worktrees actually changes, not on every openFiles edit.
  const targetsKey = useMemo(() => {
    const ids = new Set<string>()
    for (const f of openFiles) {
      ids.add(f.worktreeId)
    }
    if (activeWorktreeId) {
      ids.add(activeWorktreeId)
    }
    const parts: string[] = []
    for (const id of Array.from(ids).sort()) {
      const wt = findWorktreeById(worktreesByRepo, id)
      if (wt) {
        parts.push(`${id}::${wt.path}`)
      }
    }
    return parts.join('|')
  }, [openFiles, worktreesByRepo, activeWorktreeId])

  const targetsRef = useRef<WatchedTarget[]>([])

  useEffect(() => {
    const targets = buildWatchTargets()
    targetsRef.current = targets
    console.log('[ext-fs] useEditorExternalWatch subscribing', {
      targetsKey,
      targets: targets.map((t) => ({ id: t.worktreeId, path: t.worktreePath }))
    })

    for (const target of targets) {
      void window.api.fs.watchWorktree({
        worktreePath: target.worktreePath,
        connectionId: target.connectionId
      })
    }

    const handleFsChanged = (payload: FsChangedPayload): void => {
      console.log('[ext-fs] fs:changed received', {
        worktreePath: payload.worktreePath,
        eventCount: payload.events.length,
        events: payload.events.map((e) => ({
          kind: e.kind,
          absolutePath: e.absolutePath,
          isDirectory: e.isDirectory
        }))
      })
      const target = targetsRef.current.find(
        (t) => normalizeAbsolutePath(t.worktreePath) === normalizeAbsolutePath(payload.worktreePath)
      )
      if (!target) {
        console.log('[ext-fs] no matching watch target for payload', {
          payloadWorktreePath: payload.worktreePath,
          known: targetsRef.current.map((t) => t.worktreePath)
        })
        return
      }

      // Why: when an external process removes (or `git mv`s) a file that's
      // open in the editor, keep the tab alive and mark it as deleted/renamed
      // so the user can see the mutation and still access their in-memory
      // content. A paired create-event in the same batch signals a rename;
      // a lone delete is a hard delete. Resurrection (same path comes back
      // on disk) clears the mark further down.
      const deletedOpenEditorIds = collectDeletedOpenEditorIds(payload, target.worktreeId)
      const hasPairedCreate = payload.events.some(
        (evt) => evt.kind === 'create' && evt.isDirectory !== true
      )
      if (deletedOpenEditorIds.length > 0) {
        const setExternalMutation = useAppStore.getState().setExternalMutation
        const mutation = hasPairedCreate ? 'renamed' : 'deleted'
        for (const fileId of deletedOpenEditorIds) {
          setExternalMutation(fileId, mutation)
        }
      }

      // Why: if a previously-deleted file reappears at the same path (e.g.
      // the user ran `git checkout`), clear the tombstone so the tab returns
      // to its normal state and any non-dirty content gets reloaded below.
      const createOrUpdatePaths = new Set<string>()
      for (const evt of payload.events) {
        if (evt.isDirectory === true) {
          continue
        }
        if (evt.kind === 'create' || evt.kind === 'update') {
          createOrUpdatePaths.add(normalizeAbsolutePath(evt.absolutePath))
        }
      }
      if (createOrUpdatePaths.size > 0) {
        const state = useAppStore.getState()
        for (const file of state.openFiles) {
          if (
            file.worktreeId === target.worktreeId &&
            file.mode === 'edit' &&
            file.externalMutation &&
            createOrUpdatePaths.has(normalizeAbsolutePath(file.filePath))
          ) {
            state.setExternalMutation(file.id, null)
          }
        }
      }

      const changedFiles = new Set<string>()
      for (const evt of payload.events) {
        if (evt.kind === 'overflow') {
          // Why: on overflow the watcher can't tell us which paths changed, so
          // conservatively reload every clean open file for this worktree.
          // Bypassing `getExternalFileChangeRelativePath` because we don't
          // have individual paths — iterate openFiles directly below.
          const openFilesNow = useAppStore.getState().openFiles
          for (const file of openFilesNow) {
            if (file.worktreeId !== target.worktreeId || file.mode !== 'edit' || file.isDirty) {
              continue
            }
            notifyEditorExternalFileChange({
              worktreeId: target.worktreeId,
              worktreePath: target.worktreePath,
              relativePath: file.relativePath
            })
          }
          return
        }

        if (evt.kind === 'update' && evt.isDirectory === true) {
          continue
        }

        if (evt.kind === 'delete') {
          // Why: delete events are already handled above by marking the tab
          // as tombstoned. Feeding them into the reload pipeline would fire
          // `readFile` against the ENOENT path and replace the in-memory
          // content with "Error loading file..." — losing the user's view.
          continue
        }

        const relativePath = getExternalFileChangeRelativePath(
          target.worktreePath,
          normalizeAbsolutePath(evt.absolutePath),
          evt.isDirectory
        )
        console.log('[ext-fs] event -> relativePath', {
          kind: evt.kind,
          abs: evt.absolutePath,
          isDirectory: evt.isDirectory,
          relativePath
        })
        if (relativePath) {
          changedFiles.add(relativePath)
        }
      }

      if (changedFiles.size === 0) {
        console.log('[ext-fs] no changedFiles produced from payload')
        return
      }

      // Why: skip notifying for any tab with unsaved edits so external writes
      // don't silently destroy the user's work. Mirrors the dirty guard in
      // `useFileExplorerHandlers`. Read `openFiles` once per payload to avoid
      // N store reads for large batched events.
      const openFilesSnapshot = useAppStore.getState().openFiles
      console.log('[ext-fs] resolving changedFiles against openFiles', {
        changedFiles: Array.from(changedFiles),
        openFiles: openFilesSnapshot.map((f) => ({
          id: f.id,
          mode: f.mode,
          worktreeId: f.worktreeId,
          filePath: 'filePath' in f ? f.filePath : undefined,
          relativePath: f.relativePath,
          isDirty: f.isDirty
        }))
      })
      for (const relativePath of changedFiles) {
        const notification = {
          worktreeId: target.worktreeId,
          worktreePath: target.worktreePath,
          relativePath
        }
        const matching = getOpenFilesForExternalFileChange(openFilesSnapshot, notification)
        if (matching.length === 0) {
          console.log('[ext-fs] no open file matches', notification)
          continue
        }
        if (matching.some((f) => f.isDirty)) {
          console.log('[ext-fs] skipping notify — matching tab is dirty', {
            notification,
            matching: matching.map((f) => ({ id: f.id, isDirty: f.isDirty }))
          })
          continue
        }
        console.log('[ext-fs] notifyEditorExternalFileChange', notification)
        notifyEditorExternalFileChange(notification)
      }
    }

    const unsubscribe = window.api.fs.onFsChanged(handleFsChanged)

    return () => {
      unsubscribe()
      for (const target of targets) {
        void window.api.fs.unwatchWorktree({
          worktreePath: target.worktreePath,
          connectionId: target.connectionId
        })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Why: the effect
    // keys on `targetsKey` which already encodes the full set of watched
    // worktrees. Depending on `openFiles`/`worktreesByRepo` directly would
    // tear down and recreate subscriptions on every file-content edit.
  }, [targetsKey])
}

function collectDeletedOpenEditorIds(payload: FsChangedPayload, worktreeId: string): string[] {
  const deletePaths = new Set<string>()
  for (const evt of payload.events) {
    if (evt.kind === 'delete') {
      deletePaths.add(normalizeAbsolutePath(evt.absolutePath))
    }
  }
  if (deletePaths.size === 0) {
    return []
  }
  const openFilesNow = useAppStore.getState().openFiles
  const result: string[] = []
  for (const file of openFilesNow) {
    if (file.worktreeId !== worktreeId || file.mode !== 'edit') {
      continue
    }
    if (deletePaths.has(normalizeAbsolutePath(file.filePath))) {
      result.push(file.id)
    }
  }
  return result
}
