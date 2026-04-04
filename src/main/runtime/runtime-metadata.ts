import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { execFileSync } from 'child_process'
import { dirname, join } from 'path'

export type RuntimeTransportMetadata = {
  kind: 'unix' | 'named-pipe'
  endpoint: string
}

export type RuntimeMetadata = {
  runtimeId: string
  pid: number
  transport: RuntimeTransportMetadata | null
  authToken: string | null
  startedAt: number
}

const RUNTIME_METADATA_FILE = 'orca-runtime.json'
let cachedWindowsUserSid: string | null | undefined

export function getRuntimeMetadataPath(userDataPath: string): string {
  return join(userDataPath, RUNTIME_METADATA_FILE)
}

export function writeRuntimeMetadata(userDataPath: string, metadata: RuntimeMetadata): void {
  const metadataPath = getRuntimeMetadataPath(userDataPath)
  const dir = dirname(metadataPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  hardenRuntimePath(dir, { isDirectory: true, platform: process.platform })
  const tmpFile = `${metadataPath}.tmp`
  writeFileSync(tmpFile, JSON.stringify(metadata, null, 2), {
    encoding: 'utf-8',
    mode: 0o600
  })
  hardenRuntimePath(tmpFile, { isDirectory: false, platform: process.platform })
  renameSync(tmpFile, metadataPath)
  // Why: the runtime auth token is stored on disk so the local CLI can attach
  // to the running app. Restricting file permissions keeps that token scoped
  // to the current user on local machines.
  hardenRuntimePath(metadataPath, { isDirectory: false, platform: process.platform })
}

export function readRuntimeMetadata(userDataPath: string): RuntimeMetadata | null {
  const metadataPath = getRuntimeMetadataPath(userDataPath)
  if (!existsSync(metadataPath)) {
    return null
  }
  return JSON.parse(readFileSync(metadataPath, 'utf-8')) as RuntimeMetadata
}

export function clearRuntimeMetadata(userDataPath: string): void {
  rmSync(getRuntimeMetadataPath(userDataPath), { force: true })
}

function hardenRuntimePath(
  targetPath: string,
  options: {
    isDirectory: boolean
    platform: NodeJS.Platform
  }
): void {
  if (options.platform === 'win32') {
    bestEffortRestrictWindowsPath(targetPath)
    return
  }
  chmodSync(targetPath, options.isDirectory ? 0o700 : 0o600)
}

function bestEffortRestrictWindowsPath(targetPath: string): void {
  const currentUserSid = getCurrentWindowsUserSid()
  if (!currentUserSid) {
    return
  }
  try {
    execFileSync(
      'icacls',
      [
        targetPath,
        '/inheritance:r',
        '/grant:r',
        `*${currentUserSid}:(F)`,
        '*S-1-5-18:(F)',
        '*S-1-5-32-544:(F)'
      ],
      {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 5000
      }
    )
  } catch {
    // Why: runtime metadata hardening should not prevent Orca from starting on
    // Windows machines where icacls is unavailable or locked down differently.
  }
}

function getCurrentWindowsUserSid(): string | null {
  if (cachedWindowsUserSid !== undefined) {
    return cachedWindowsUserSid
  }
  try {
    const output = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000
    }).trim()
    const columns = parseCsvLine(output)
    cachedWindowsUserSid = columns[1] ?? null
  } catch {
    cachedWindowsUserSid = null
  }
  return cachedWindowsUserSid
}

function parseCsvLine(line: string): string[] {
  return line.split(/","/).map((part) => part.replace(/^"/, '').replace(/"$/, ''))
}
