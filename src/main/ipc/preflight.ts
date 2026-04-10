import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export type PreflightStatus = {
  git: { installed: boolean }
  gh: { installed: boolean; authenticated: boolean }
}

// Why: cache the result so repeated Landing mounts don't re-spawn processes.
// The check only runs once per app session — relaunch to re-check.
let cached: PreflightStatus | null = null

/** @internal - tests need a clean preflight cache between cases. */
export function _resetPreflightCache(): void {
  cached = null
}

async function isCommandAvailable(command: string): Promise<boolean> {
  try {
    await execFileAsync(command, ['--version'])
    return true
  } catch {
    return false
  }
}

async function isGhAuthenticated(): Promise<boolean> {
  try {
    await execFileAsync('gh', ['auth', 'status'], {
      encoding: 'utf-8'
    })
    // Why: newer gh versions can change the human-readable wording, but a zero
    // exit from `gh auth status` still means the CLI has a usable login.
    return true
  } catch (error) {
    // Why: older gh builds wrote successful auth details to stderr, and some
    // environments surface partial output on the thrown error object. Keep a
    // compatibility fallback so we do not show a false "not authenticated"
    // banner just because the text landed on an unexpected stream.
    const stdout = (error as { stdout?: string }).stdout ?? ''
    const stderr = (error as { stderr?: string }).stderr ?? ''
    const output = `${stdout}\n${stderr}`
    return output.includes('Logged in') || output.includes('Active account: true')
  }
}

export async function runPreflightCheck(force = false): Promise<PreflightStatus> {
  if (cached && !force) {
    return cached
  }

  const [gitInstalled, ghInstalled] = await Promise.all([
    isCommandAvailable('git'),
    isCommandAvailable('gh')
  ])

  const ghAuthenticated = ghInstalled ? await isGhAuthenticated() : false

  cached = {
    git: { installed: gitInstalled },
    gh: { installed: ghInstalled, authenticated: ghAuthenticated }
  }

  return cached
}

export function registerPreflightHandlers(): void {
  ipcMain.handle(
    'preflight:check',
    async (_event, args?: { force?: boolean }): Promise<PreflightStatus> => {
      return runPreflightCheck(args?.force)
    }
  )
}
