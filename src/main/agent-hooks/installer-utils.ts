import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  copyFileSync,
  renameSync,
  unlinkSync
} from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { grantDirAcl, isPermissionError } from '../win32-utils'

// Why: single source of truth for the agent-hooks directory name so
// `getAgentHooksDir` (the dir where the endpoint file + managed scripts
// live) and `createManagedCommandMatcher` (which sweeps stale entries
// by matching this substring) cannot drift apart. Renaming the dir
// means updating exactly one place.
const AGENT_HOOKS_DIR_NAME = 'agent-hooks'

// CRITICAL INVARIANT: the managed hook scripts and the endpoint file MUST
// live in the same directory on disk.
//
// Why this matters: a daemon-revived PTY (one that survived an Orca restart)
// has stale PORT/TOKEN in its env and — if it was spawned before PR #1196 —
// no ORCA_AGENT_HOOK_ENDPOINT at all. The only way its managed hook script
// can find the live endpoint file is by deriving the path from its *own*
// location (`$(dirname "$0")/endpoint.env` on POSIX, `%~dp0endpoint.cmd` on
// Windows). That trick only works if the two files are co-located.
//
// Every read or write of a path under this directory MUST go through
// `getAgentHooksDir()` (or an adjacent helper that does) so a future
// refactor that moves one file cannot silently break the other. Changing
// the directory name here is a deliberate, coordinated change — search for
// `getAgentHooksDir` to find every caller; the invariant test in
// `installer-utils.test.ts` asserts script and endpoint share a dirname.
export function getAgentHooksDir(userDataPath: string): string {
  return join(userDataPath, AGENT_HOOKS_DIR_NAME)
}

// Why: the endpoint file lives under userData so each Orca install (dev vs.
// packaged) has its own path and the two cannot clobber each other. Using a
// per-platform extension (`.env` on POSIX, `.cmd` on Windows) lets the hook
// scripts source the file with their platform-native syntax (`.` on POSIX,
// `call` on Windows); the OpenCode plugin's regex accepts both shapes so no
// platform detection is needed inside the plugin source either.
// Lives in installer-utils so both the hook server (which writes the file)
// and the managed-script generators (which source it from the script) share
// one source of truth for the filename convention.
export function getEndpointFileName(): string {
  return process.platform === 'win32' ? 'endpoint.cmd' : 'endpoint.env'
}

// Why: single accessor for the endpoint file path. Composing it from
// `getAgentHooksDir` + `getEndpointFileName` guarantees the discovery
// invariant: the endpoint file always sits in the directory the scripts
// resolve at invocation time via `$0`/`%~dp0`.
export function getEndpointFilePath(userDataPath: string): string {
  return join(getAgentHooksDir(userDataPath), getEndpointFileName())
}

// Why: single accessor for a managed-script path. Used by every agent's
// hook-service so the co-location invariant cannot be accidentally violated
// by one service drifting to a different directory from the others.
export function getManagedScriptPathForAgent(userDataPath: string, scriptFileName: string): string {
  return join(getAgentHooksDir(userDataPath), scriptFileName)
}

// Why: PTYs kept alive by the persistent-terminal daemon survive Orca
// restarts, so the PORT/TOKEN baked into their env at original spawn time
// goes stale the moment Orca restarts and rebinds the hook server. The
// endpoint file (written by the server on every start) carries the current
// coordinates — but hook scripts could previously only find it via
// $ORCA_AGENT_HOOK_ENDPOINT, which is also frozen in the PTY's env. PTYs
// spawned before the endpoint-file feature landed (PR #1196) have no
// ORCA_AGENT_HOOK_ENDPOINT at all, so their managed hook scripts post to
// the dead old port and the dashboard silently shows nothing for any agent
// CLI started inside them after the restart.
//
// Fix: the managed script lives in a known location
// (`userData/agent-hooks/<agent>-hook.sh`) and the endpoint file sits right
// next to it (`userData/agent-hooks/endpoint.env`). Derive the endpoint
// path from the script's own location at invocation time and source that as
// a fallback when the env var is absent. Both POSIX (via `$0`) and Windows
// (via `%~dp0`) expose the script's own path, so the discovery is
// self-contained and survives any future renames of the `ORCA_AGENT_HOOK_*`
// env contract.
export function getEndpointDiscoveryShellSnippet(): string[] {
  // Why: resolve via `$0` → `dirname` so it works whether the agent invoked
  // the script by basename, relative path, or absolute path. The guard
  // blocks `.`-sourcing a non-regular file (e.g. a directory with the same
  // name, which `.` would error on). `|| :` swallows parse errors from a
  // TOCTOU race or malformed line the same way the env-var path does.
  return [
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    `elif _orca_ep="$(dirname "$0")/${getEndpointFileName()}"; [ -r "$_orca_ep" ]; then`,
    '  . "$_orca_ep" 2>/dev/null || :',
    'fi',
    'unset _orca_ep 2>/dev/null || :'
  ]
}

export function getEndpointDiscoveryCmdSnippet(): string[] {
  // Why: `%~dp0` already includes a trailing backslash, so concatenating the
  // filename produces a well-formed absolute path even when the script is
  // invoked by basename via PATH.
  //
  // Why the `_orca_loaded` flag (and not `if not defined ORCA_AGENT_HOOK_PORT`):
  // the exact scenario this fallback exists for is a daemon-revived PTY that
  // was spawned before the endpoint-file feature landed (PR #1196). That PTY
  // has a *stale* ORCA_AGENT_HOOK_PORT baked into its env from the prior
  // Orca, and no ORCA_AGENT_HOOK_ENDPOINT at all. Gating the fallback on
  // "PORT undefined" would short-circuit in exactly this case and leave the
  // script posting to the dead port. Gating on "env-var branch did not
  // successfully source a file" mirrors the POSIX `if/elif` semantics and
  // fires whenever the env-var branch was skipped or its file was missing.
  //
  // We use `&&` (not `&`) so the flag fires only when the `call` itself
  // returned 0; a parse error inside the endpoint file then correctly falls
  // through to the script-adjacent endpoint rather than being masked by an
  // unconditional `_orca_loaded=1`.
  return [
    'set _orca_loaded=',
    'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" (call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul && set _orca_loaded=1)',
    `if not defined _orca_loaded if exist "%~dp0${getEndpointFileName()}" call "%~dp0${getEndpointFileName()}" 2>nul`,
    'set _orca_loaded='
  ]
}

export type HookCommandConfig = {
  type: 'command'
  command: string
  timeout?: number
  [key: string]: unknown
}

export type HookDefinition = {
  matcher?: string
  hooks?: HookCommandConfig[]
  [key: string]: unknown
}

export type HooksConfig = {
  hooks?: Record<string, HookDefinition[]>
  [key: string]: unknown
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readHooksJson(configPath: string): HooksConfig | null {
  if (!existsSync(configPath)) {
    return {}
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'))
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

// Why: callers in install/remove need to match not just the exact current
// managed command, but also stale entries pointing at old script paths — e.g.
// from a previous dev build with a different Electron userData dir, or a
// parallel dev/prod install. Matching by the managed script's file name
// (under any `agent-hooks/` directory) lets a fresh install sweep those
// without touching unrelated user-authored hooks.
//
// NOTE: the directory segment comes from `AGENT_HOOKS_DIR_NAME` so a rename
// cannot desync the matcher from `getAgentHooksDir`. If the directory is
// ever renamed, this matcher also needs to recognize the old name during a
// transition window so a fresh install can still sweep pre-rename entries
// out of the user's hook config.
export function createManagedCommandMatcher(
  scriptFileName: string
): (command: string | undefined) => boolean {
  const needle = `${AGENT_HOOKS_DIR_NAME}/${scriptFileName}`
  return (command) => {
    if (!command) {
      return false
    }
    return command.replaceAll('\\', '/').includes(needle)
  }
}

export function removeManagedCommands(
  definitions: HookDefinition[],
  isManagedCommand: (command: string | undefined) => boolean
): HookDefinition[] {
  return definitions.flatMap((definition) => {
    if (!Array.isArray(definition.hooks)) {
      return [definition]
    }

    const filteredHooks = definition.hooks.filter((hook) => !isManagedCommand(hook.command))
    if (filteredHooks.length === 0) {
      return []
    }

    return [{ ...definition, hooks: filteredHooks }]
  })
}

export function writeManagedScript(scriptPath: string, content: string): void {
  mkdirSync(dirname(scriptPath), { recursive: true })
  writeScriptWithAclRetry(scriptPath, content)
  if (process.platform !== 'win32') {
    chmodSync(scriptPath, 0o755)
  }
}

// Why: on Windows, Chromium's renderer initialization can reset the DACL on
// the userData directory (Protected DACL without OI+CI propagation), leaving
// child directories like agent-hooks with an empty DACL. Grant an explicit
// directory ACL on EPERM and retry once.
function writeScriptWithAclRetry(scriptPath: string, content: string): void {
  try {
    writeFileSync(scriptPath, content, 'utf-8')
  } catch (error) {
    if (isPermissionError(error) && process.platform === 'win32') {
      try {
        grantDirAcl(dirname(scriptPath))
        writeFileSync(scriptPath, content, 'utf-8')
        return
      } catch {
        // icacls failure is not actionable; re-throw the original EPERM
      }
    }
    throw error
  }
}

export function writeHooksJson(configPath: string, config: HooksConfig): void {
  const dir = dirname(configPath)
  mkdirSync(dir, { recursive: true })

  // Why: write to a temp file then rename so a crash or disk-full mid-write
  // leaves the original untouched. This is the only safe way to update a
  // config file the user may have hand-edited.
  //
  // Why randomUUID: Date.now() alone collides when two install() calls fire in
  // the same millisecond targeting the same dir (e.g. a future caller that
  // installs multiple agents sharing a config dir, or rapid reinstalls from
  // the settings UI). A collision would corrupt one of the two writes. The
  // UUID suffix makes the tmp path unique per call.
  const tmpPath = join(dir, `.${Date.now()}-${randomUUID()}.tmp`)
  const serialized = `${JSON.stringify(config, null, 2)}\n`

  // Why: skip the write (and therefore the .bak rotation) when the on-disk
  // content is already identical. Without this, every install() rewrites the
  // file and rolls the backup forward, which can silently destroy the last
  // recoverable copy if install() is called repeatedly (e.g. on app start).
  if (existsSync(configPath)) {
    try {
      if (readFileSync(configPath, 'utf-8') === serialized) {
        return
      }
    } catch {
      // Fall through to the normal write path — a read error here is not
      // worth failing the install for; the atomic write below will either
      // succeed or throw loudly.
    }
  }

  try {
    writeFileSync(tmpPath, serialized, 'utf-8')
    // Why: single rolling backup — one file, no accumulation in ~/.claude.
    // Protects against a merge-logic bug producing bad JSON; the original is
    // always recoverable from <configPath>.bak until the next write.
    if (existsSync(configPath)) {
      copyFileSync(configPath, `${configPath}.bak`)
    }
    renameSync(tmpPath, configPath)
  } finally {
    // Clean up temp file if rename failed.
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // best effort
      }
    }
  }
}
