import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  createManagedCommandMatcher,
  getAgentHooksDir,
  getEndpointDiscoveryCmdSnippet,
  getEndpointDiscoveryShellSnippet,
  getEndpointFileName,
  getEndpointFilePath,
  getManagedScriptPathForAgent,
  writeHooksJson,
  type HooksConfig
} from './installer-utils'

let tmpDir: string
let configPath: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'orca-installer-utils-test-'))
  configPath = join(tmpDir, 'settings.json')
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('writeHooksJson', () => {
  it('writes the config as formatted JSON', () => {
    const config: HooksConfig = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'foo' }] }] }
    }
    writeHooksJson(configPath, config)
    const written = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(written).toEqual(config)
  })

  it('creates the directory if it does not exist', () => {
    const nested = join(tmpDir, 'sub', 'dir', 'settings.json')
    writeHooksJson(nested, {})
    expect(existsSync(nested)).toBe(true)
  })

  it('creates a .bak file from the previous content before overwriting', () => {
    const original: HooksConfig = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'original' }] }] }
    }
    writeFileSync(configPath, `${JSON.stringify(original, null, 2)}\n`, 'utf-8')

    const updated: HooksConfig = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'updated' }] }] }
    }
    writeHooksJson(configPath, updated)

    const bak = JSON.parse(readFileSync(`${configPath}.bak`, 'utf-8'))
    expect(bak).toEqual(original)
  })

  it('does not create a .bak file when the config does not yet exist', () => {
    writeHooksJson(configPath, {})
    expect(existsSync(`${configPath}.bak`)).toBe(false)
  })

  it('is a no-op (does not rotate .bak) when the serialized content is unchanged', () => {
    const config: HooksConfig = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'foo' }] }] }
    }
    writeHooksJson(configPath, config)
    // First write had no prior file, so no .bak should exist.
    expect(existsSync(`${configPath}.bak`)).toBe(false)

    // Writing identical content must not create or rotate the .bak file.
    writeHooksJson(configPath, config)
    expect(existsSync(`${configPath}.bak`)).toBe(false)

    // A second distinct write must still produce a .bak from the prior content,
    // proving the no-op only triggers on byte-identical content.
    const updated: HooksConfig = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'bar' }] }] }
    }
    writeHooksJson(configPath, updated)
    const bak = JSON.parse(readFileSync(`${configPath}.bak`, 'utf-8'))
    expect(bak).toEqual(config)
  })

  it('updates the .bak file to the previous version on each write', () => {
    const v1: HooksConfig = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'v1' }] }] } }
    const v2: HooksConfig = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'v2' }] }] } }
    const v3: HooksConfig = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'v3' }] }] } }

    writeHooksJson(configPath, v1)
    writeHooksJson(configPath, v2)
    writeHooksJson(configPath, v3)

    // .bak should hold v2 (the version before v3)
    const bak = JSON.parse(readFileSync(`${configPath}.bak`, 'utf-8'))
    expect(bak).toEqual(v2)
    // configPath should hold v3
    const current = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(current).toEqual(v3)
  })

  it('leaves no temp file behind if the rename fails', () => {
    // Why: verifies the atomic cleanup — if the rename cannot complete (here,
    // because the target is a directory that cannot be overwritten), the finally
    // block must remove the temp file so ~/.claude is not littered with orphans.
    const blockingDir = configPath
    mkdirSync(blockingDir)

    expect(() => writeHooksJson(blockingDir, { hooks: {} })).toThrow()

    const entries = readdirSync(tmpDir)
    expect(entries.filter((e) => e.endsWith('.tmp'))).toHaveLength(0)
  })
})

describe('createManagedCommandMatcher', () => {
  const match = createManagedCommandMatcher('claude-hook.sh')

  it('matches commands containing the agent-hooks/<scriptFileName> path', () => {
    expect(
      match('/bin/sh "/Users/alice/Library/Application Support/Orca/agent-hooks/claude-hook.sh"')
    ).toBe(true)
    expect(match('/bin/sh "/some/other/location/agent-hooks/claude-hook.sh"')).toBe(true)
  })

  it('normalizes Windows backslashes so cmd-style paths still match', () => {
    expect(match('C:\\Users\\alice\\AppData\\Roaming\\Orca\\agent-hooks\\claude-hook.sh')).toBe(
      true
    )
  })

  it('returns false for unrelated commands', () => {
    expect(match(undefined)).toBe(false)
    expect(match('')).toBe(false)
    expect(match('echo "user-authored hook"')).toBe(false)
    // Same filename but not under an agent-hooks/ directory — treat as
    // user-authored to avoid stomping on someone else's hook.
    expect(match('/bin/sh "/home/alice/scripts/claude-hook.sh"')).toBe(false)
  })

  it('does not match hooks for a different agent', () => {
    expect(match('/bin/sh "/path/agent-hooks/gemini-hook.sh"')).toBe(false)
  })
})

// Why: the discovery snippets are what lets daemon-revived PTYs keep
// reporting status to Orca across restarts — the snippet has to prefer the
// PTY's env var (which is how new-terminal spawns pick up the current
// port/token fast) and fall back to the script-adjacent endpoint file
// (which is how surviving daemon PTYs recover after their env went stale).
// If either branch regresses the dashboard silently stops updating for one
// of the two spawn paths, so assert both branches are wired up.
describe('getEndpointDiscoveryShellSnippet', () => {
  it('prefers the env-var endpoint before falling back to the script-adjacent file', () => {
    const snippet = getEndpointDiscoveryShellSnippet().join('\n')
    expect(snippet).toContain('$ORCA_AGENT_HOOK_ENDPOINT')
    // Script-adjacent fallback must reference the platform-specific filename
    // and resolve the dir from $0 so the script keeps working when invoked
    // by basename, relative path, or absolute path.
    expect(snippet).toContain(`$(dirname "$0")/${getEndpointFileName()}`)
    // Env-var branch must source before the script-adjacent branch so fresh
    // terminals (which always have a current endpoint env) don't pay the
    // filesystem-stat cost of the fallback.
    const envIdx = snippet.indexOf('$ORCA_AGENT_HOOK_ENDPOINT')
    const adjIdx = snippet.indexOf('dirname "$0"')
    expect(envIdx).toBeGreaterThan(-1)
    expect(adjIdx).toBeGreaterThan(envIdx)
  })
})

describe('getEndpointDiscoveryCmdSnippet', () => {
  it('prefers the env-var endpoint before falling back to the script-adjacent file', () => {
    const snippet = getEndpointDiscoveryCmdSnippet().join('\r\n')
    expect(snippet).toContain('%ORCA_AGENT_HOOK_ENDPOINT%')
    // Script-adjacent fallback must use %~dp0 (which already includes a
    // trailing backslash) + the platform filename.
    expect(snippet).toContain(`%~dp0${getEndpointFileName()}`)
    // Why: the fallback must gate on "env-var branch did not successfully
    // source a file" (tracked via _orca_loaded), NOT on "PORT undefined".
    // The bug this fallback exists to fix is a daemon-revived pre-#1196 PTY
    // whose env has a stale ORCA_AGENT_HOOK_PORT baked in — gating on PORT
    // would short-circuit in exactly that case and leave the script posting
    // to the dead port.
    expect(snippet).toContain('if not defined _orca_loaded')
    expect(snippet).not.toMatch(/if not defined ORCA_AGENT_HOOK_PORT/)
    // Env-var branch sets the flag only on successful source so the
    // fallback correctly skips when a fresh PTY already loaded the file.
    expect(snippet).toContain('set _orca_loaded=1')
    // Flag must be cleared before and after so a surrounding script that
    // somehow inherited _orca_loaded cannot skew the gate, and our own
    // flag does not leak to anything the agent runs afterwards.
    const lines = snippet.split('\r\n')
    expect(lines.at(0)).toBe('set _orca_loaded=')
    expect(lines.at(-1)).toBe('set _orca_loaded=')
  })
})

// Why: the endpoint file and every managed hook script MUST share a
// directory so that hook scripts can discover the endpoint file at runtime
// via `$(dirname "$0")` (POSIX) or `%~dp0` (Windows). That discovery is
// the only recovery path for daemon-revived PTYs whose PTY env has gone
// stale across an Orca restart — if the two files ever drift apart, every
// pre-#1196 daemon-revived PTY silently stops reporting. Lock the
// invariant in a test so a refactor that renames the dir in one call site
// but not another fails loudly here instead of quietly in production.
describe('agent-hooks directory co-location invariant', () => {
  it('endpoint file and a representative managed script share a dirname', () => {
    const userData = '/fake/userData'
    const endpointPath = getEndpointFilePath(userData)
    // Representative agent — if any one agent's script path drifts from the
    // endpoint file's directory, the test fails. The hook-services all go
    // through `getManagedScriptPathForAgent`, so asserting one is enough.
    const scriptPath = getManagedScriptPathForAgent(userData, 'claude-hook.sh')
    expect(dirname(endpointPath)).toBe(getAgentHooksDir(userData))
    expect(dirname(scriptPath)).toBe(getAgentHooksDir(userData))
    expect(dirname(endpointPath)).toBe(dirname(scriptPath))
  })
})
