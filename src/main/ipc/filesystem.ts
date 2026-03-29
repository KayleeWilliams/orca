/* eslint-disable max-lines */
import { ipcMain, shell } from 'electron'
import { readdir, readFile, writeFile, stat, lstat } from 'fs/promises'
import { extname, relative } from 'path'
import { spawn } from 'child_process'
import type { Store } from '../persistence'
import type {
  DirEntry,
  GitBranchCompareResult,
  GitStatusEntry,
  GitDiffResult,
  SearchOptions,
  SearchResult,
  SearchFileResult
} from '../../shared/types'
import {
  getStatus,
  getDiff,
  stageFile,
  unstageFile,
  discardChanges,
  getBranchCompare,
  getBranchDiff
} from '../git/status'
import {
  resolveAuthorizedPath,
  resolveRegisteredWorktreePath,
  validateGitRelativeFilePath,
  isENOENT
} from './filesystem-auth'
import { listQuickOpenFiles } from './filesystem-list-files'

const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB
const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon'
}

function normalizeRelativePath(path: string): string {
  return path.replace(/[\\/]+/g, '/').replace(/^\/+/, '')
}

/**
 * Check if a buffer appears to be binary (contains null bytes in first 8KB).
 */
function isBinaryBuffer(buffer: Buffer): boolean {
  const len = Math.min(buffer.length, 8192)
  for (let i = 0; i < len; i++) {
    if (buffer[i] === 0) {
      return true
    }
  }
  return false
}

export function registerFilesystemHandlers(store: Store): void {
  // ─── Filesystem ─────────────────────────────────────────
  ipcMain.handle('fs:readDir', async (_event, args: { dirPath: string }): Promise<DirEntry[]> => {
    const dirPath = await resolveAuthorizedPath(args.dirPath, store)
    const entries = await readdir(dirPath, { withFileTypes: true })
    return entries
      .map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isSymlink: entry.isSymbolicLink()
      }))
      .sort((a, b) => {
        // Directories first, then alphabetical
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1
        }
        return a.name.localeCompare(b.name)
      })
  })

  ipcMain.handle(
    'fs:readFile',
    async (
      _event,
      args: { filePath: string }
    ): Promise<{ content: string; isBinary: boolean; isImage?: boolean; mimeType?: string }> => {
      const filePath = await resolveAuthorizedPath(args.filePath, store)
      const stats = await stat(filePath)
      if (stats.size > MAX_FILE_SIZE) {
        throw new Error(
          `File too large: ${(stats.size / 1024 / 1024).toFixed(1)}MB exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit`
        )
      }

      const buffer = await readFile(filePath)
      const mimeType = IMAGE_MIME_TYPES[extname(filePath).toLowerCase()]
      if (mimeType) {
        return {
          content: buffer.toString('base64'),
          isBinary: true,
          isImage: true,
          mimeType
        }
      }

      if (isBinaryBuffer(buffer)) {
        return { content: '', isBinary: true }
      }

      return { content: buffer.toString('utf-8'), isBinary: false }
    }
  )

  ipcMain.handle(
    'fs:writeFile',
    async (_event, args: { filePath: string; content: string }): Promise<void> => {
      const filePath = await resolveAuthorizedPath(args.filePath, store)

      try {
        const fileStats = await lstat(filePath)
        if (fileStats.isDirectory()) {
          throw new Error('Cannot write to a directory')
        }
      } catch (error) {
        if (!isENOENT(error)) {
          throw error
        }
      }

      await writeFile(filePath, args.content, 'utf-8')
    }
  )

  ipcMain.handle('fs:deletePath', async (_event, args: { targetPath: string }): Promise<void> => {
    const targetPath = await resolveAuthorizedPath(args.targetPath, store)

    await shell.trashItem(targetPath)
  })

  ipcMain.handle(
    'fs:stat',
    async (
      _event,
      args: { filePath: string }
    ): Promise<{ size: number; isDirectory: boolean; mtime: number }> => {
      const filePath = await resolveAuthorizedPath(args.filePath, store)
      const stats = await stat(filePath)
      return {
        size: stats.size,
        isDirectory: stats.isDirectory(),
        mtime: stats.mtimeMs
      }
    }
  )

  // ─── Search ────────────────────────────────────────────
  ipcMain.handle('fs:search', async (_event, args: SearchOptions): Promise<SearchResult> => {
    const rootPath = await resolveAuthorizedPath(args.rootPath, store)

    const maxResults = args.maxResults ?? 10000

    return new Promise((resolvePromise) => {
      const rgArgs: string[] = [
        '--json',
        '--hidden',
        '--glob',
        '!.git',
        '--max-count',
        '200', // max matches per file
        '--max-filesize',
        `${Math.floor(MAX_FILE_SIZE / 1024 / 1024)}M`
      ]

      if (!args.caseSensitive) {
        rgArgs.push('--ignore-case')
      }
      if (args.wholeWord) {
        rgArgs.push('--word-regexp')
      }
      if (!args.useRegex) {
        rgArgs.push('--fixed-strings')
      }
      if (args.includePattern) {
        for (const pat of args.includePattern
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)) {
          rgArgs.push('--glob', pat)
        }
      }
      if (args.excludePattern) {
        for (const pat of args.excludePattern
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)) {
          rgArgs.push('--glob', `!${pat}`)
        }
      }

      rgArgs.push('--', args.query, rootPath)

      const fileMap = new Map<string, SearchFileResult>()
      let totalMatches = 0
      let truncated = false
      let stdoutBuffer = ''
      let resolved = false

      const resolveOnce = (): void => {
        if (resolved) {
          return
        }
        resolved = true
        clearTimeout(killTimeout)
        resolvePromise({
          files: Array.from(fileMap.values()),
          totalMatches,
          truncated
        })
      }

      const processLine = (line: string): void => {
        if (!line || totalMatches >= maxResults) {
          return
        }

        try {
          const msg = JSON.parse(line)
          if (msg.type !== 'match') {
            return
          }

          const data = msg.data
          const absPath: string = data.path.text
          const relPath = normalizeRelativePath(relative(rootPath, absPath))

          let fileResult = fileMap.get(absPath)
          if (!fileResult) {
            fileResult = { filePath: absPath, relativePath: relPath, matches: [] }
            fileMap.set(absPath, fileResult)
          }

          for (const sub of data.submatches) {
            fileResult.matches.push({
              line: data.line_number,
              column: sub.start + 1,
              matchLength: sub.end - sub.start,
              lineContent: data.lines.text.replace(/\n$/, '')
            })
            totalMatches++
            if (totalMatches >= maxResults) {
              truncated = true
              child.kill()
              break
            }
          }
        } catch {
          // skip malformed JSON lines
        }
      }

      const child = spawn('rg', rgArgs, { stdio: ['ignore', 'pipe', 'pipe'] })

      child.stdout.setEncoding('utf-8')
      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer += chunk
        const lines = stdoutBuffer.split('\n')
        stdoutBuffer = lines.pop() ?? ''
        for (const line of lines) {
          processLine(line)
        }
      })
      child.stderr.on('data', () => {
        // Drain stderr so rg cannot block on a full pipe.
      })

      child.once('error', () => {
        resolveOnce()
      })

      child.once('close', () => {
        if (stdoutBuffer) {
          processLine(stdoutBuffer)
        }
        resolveOnce()
      })

      // Kill after 30s if still running
      const killTimeout = setTimeout(() => child.kill(), 30000)
    })
  })

  // ─── List all files (for quick-open) ─────────────────────
  ipcMain.handle(
    'fs:listFiles',
    async (_event, args: { rootPath: string }): Promise<string[]> =>
      listQuickOpenFiles(args.rootPath, store)
  )

  // ─── Git operations ─────────────────────────────────────
  ipcMain.handle(
    'git:status',
    async (_event, args: { worktreePath: string }): Promise<GitStatusEntry[]> => {
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      return getStatus(worktreePath)
    }
  )

  ipcMain.handle(
    'git:diff',
    async (
      _event,
      args: { worktreePath: string; filePath: string; staged: boolean }
    ): Promise<GitDiffResult> => {
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePath = validateGitRelativeFilePath(worktreePath, args.filePath)
      return getDiff(worktreePath, filePath, args.staged)
    }
  )

  ipcMain.handle(
    'git:branchCompare',
    async (
      _event,
      args: { worktreePath: string; baseRef: string }
    ): Promise<GitBranchCompareResult> => {
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      return getBranchCompare(worktreePath, args.baseRef)
    }
  )

  ipcMain.handle(
    'git:branchDiff',
    async (
      _event,
      args: {
        worktreePath: string
        compare: {
          baseRef: string
          baseOid: string
          headOid: string
          mergeBase: string
        }
        filePath: string
        oldPath?: string
      }
    ): Promise<GitDiffResult> => {
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePath = validateGitRelativeFilePath(worktreePath, args.filePath)
      const oldPath = args.oldPath
        ? validateGitRelativeFilePath(worktreePath, args.oldPath)
        : undefined
      return getBranchDiff(worktreePath, {
        mergeBase: args.compare.mergeBase,
        headOid: args.compare.headOid,
        filePath,
        oldPath
      })
    }
  )

  ipcMain.handle(
    'git:stage',
    async (_event, args: { worktreePath: string; filePath: string }): Promise<void> => {
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePath = validateGitRelativeFilePath(worktreePath, args.filePath)
      await stageFile(worktreePath, filePath)
    }
  )

  ipcMain.handle(
    'git:unstage',
    async (_event, args: { worktreePath: string; filePath: string }): Promise<void> => {
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePath = validateGitRelativeFilePath(worktreePath, args.filePath)
      await unstageFile(worktreePath, filePath)
    }
  )

  ipcMain.handle(
    'git:discard',
    async (_event, args: { worktreePath: string; filePath: string }): Promise<void> => {
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePath = validateGitRelativeFilePath(worktreePath, args.filePath)
      await discardChanges(worktreePath, filePath)
    }
  )
}
