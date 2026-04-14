import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { dirname } from 'path'

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
  writeFileSync(scriptPath, content, 'utf-8')
  if (process.platform !== 'win32') {
    chmodSync(scriptPath, 0o755)
  }
}

export function writeHooksJson(configPath: string, config: HooksConfig): void {
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8')
}
