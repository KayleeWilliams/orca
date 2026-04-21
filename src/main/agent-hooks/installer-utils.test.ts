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
import { join } from 'path'
import { writeHooksJson, type HooksConfig } from './installer-utils'

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
