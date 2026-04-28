import { execFile as execFileCb } from 'child_process'
import { existsSync } from 'fs'
import { promisify } from 'util'

const execFile = promisify(execFileCb)

/**
 * Resolve the current working directory of a local process by pid.
 *
 * Why duplicated from `src/relay/pty-shell-utils.ts`: the relay and Electron
 * main process have separate build graphs, and cross-importing across them
 * is not a pattern used in this repo. The function is short and pure, and
 * the duplication is cheaper than reshaping both bundle graphs.
 *
 * Tries `/proc/<pid>/cwd` on Linux, falls back to `lsof -d cwd` on macOS.
 * Returns `fallbackCwd` when neither works (including Windows, where
 * `/proc` is absent and `lsof` is not native).
 */
export async function resolveProcessCwd(pid: number, fallbackCwd: string): Promise<string> {
  const procCwd = `/proc/${pid}/cwd`
  if (existsSync(procCwd)) {
    try {
      const { readlinkSync } = await import('fs')
      return readlinkSync(procCwd)
    } catch {
      /* fall through */
    }
  }

  try {
    const { stdout } = await execFile('lsof', ['-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf-8',
      timeout: 3000
    })
    for (const line of stdout.split('\n')) {
      if (line.startsWith('n') && line.includes('/')) {
        const candidate = line.slice(1)
        if (existsSync(candidate)) {
          return candidate
        }
      }
    }
  } catch {
    /* fall through */
  }

  return fallbackCwd
}
