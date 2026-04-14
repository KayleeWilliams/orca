import { homedir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  readHooksJson,
  removeManagedCommands,
  writeHooksJson,
  writeManagedScript,
  type HookDefinition
} from '../agent-hooks/installer-utils'

const CLAUDE_EVENTS = [
  { eventName: 'UserPromptSubmit', definition: { hooks: [{ type: 'command', command: '' }] } },
  { eventName: 'Stop', definition: { hooks: [{ type: 'command', command: '' }] } },
  {
    eventName: 'PostToolUse',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'PostToolUseFailure',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'PermissionRequest',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  }
] as const

function getConfigPath(): string {
  return join(homedir(), '.claude', 'settings.json')
}

function getManagedScriptPath(): string {
  return join(
    app.getPath('userData'),
    'agent-hooks',
    process.platform === 'win32' ? 'claude-hook.cmd' : 'claude-hook.sh'
  )
}

function getManagedCommand(scriptPath: string): string {
  return process.platform === 'win32' ? scriptPath : `/bin/sh "${scriptPath}"`
}

function getManagedScript(): string {
  if (process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      'if "%ORCA_AGENT_HOOK_PORT%"=="" exit /b 0',
      'if "%ORCA_AGENT_HOOK_TOKEN%"=="" exit /b 0',
      'if "%ORCA_PANE_KEY%"=="" exit /b 0',
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "$inputData=[Console]::In.ReadToEnd(); if ([string]::IsNullOrWhiteSpace($inputData)) { exit 0 }; try { $body=@{ paneKey=$env:ORCA_PANE_KEY; payload=($inputData | ConvertFrom-Json) } | ConvertTo-Json -Depth 100; Invoke-WebRequest -UseBasicParsing -Method Post -Uri ('http://127.0.0.1:' + $env:ORCA_AGENT_HOOK_PORT + '/hook/claude') -Headers @{ 'Content-Type'='application/json'; 'X-Orca-Agent-Hook-Token'=$env:ORCA_AGENT_HOOK_TOKEN } -Body $body | Out-Null } catch {}"`,
      'exit /b 0',
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  exit 0',
    'fi',
    'payload=$(cat)',
    'if [ -z "$payload" ]; then',
    '  exit 0',
    'fi',
    `body=$(printf '{"paneKey":"%s","payload":%s}' "$ORCA_PANE_KEY" "$payload")`,
    'curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/claude" \\',
    '  -H "Content-Type: application/json" \\',
    '  -H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \\',
    '  --data-binary "$body" >/dev/null 2>&1 || true',
    'exit 0',
    ''
  ].join('\n')
}

export class ClaudeHookService {
  getStatus(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const scriptPath = getManagedScriptPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'claude',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Claude settings.json'
      }
    }

    const managedHooksPresent = Object.values(config.hooks ?? {}).some((definitions) =>
      definitions.some((definition) =>
        (definition.hooks ?? []).some((hook) => hook.command === getManagedCommand(scriptPath))
      )
    )

    return {
      agent: 'claude',
      state: managedHooksPresent ? 'installed' : 'not_installed',
      configPath,
      managedHooksPresent,
      detail: null
    }
  }

  install(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const scriptPath = getManagedScriptPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'claude',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Claude settings.json'
      }
    }

    const command = getManagedCommand(scriptPath)
    const nextHooks = { ...config.hooks }

    for (const event of CLAUDE_EVENTS) {
      const current = Array.isArray(nextHooks[event.eventName]) ? nextHooks[event.eventName] : []
      const cleaned = removeManagedCommands(current, (currentCommand) => currentCommand === command)
      const definition: HookDefinition = {
        ...event.definition,
        hooks: [{ type: 'command', command }]
      }
      nextHooks[event.eventName] = [...cleaned, definition]
    }

    config.hooks = nextHooks
    writeManagedScript(scriptPath, getManagedScript())
    writeHooksJson(configPath, config)
    return this.getStatus()
  }

  remove(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const scriptPath = getManagedScriptPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'claude',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Claude settings.json'
      }
    }

    const command = getManagedCommand(scriptPath)
    const nextHooks = { ...config.hooks }
    for (const [eventName, definitions] of Object.entries(nextHooks)) {
      const cleaned = removeManagedCommands(
        definitions,
        (currentCommand) => currentCommand === command
      )
      if (cleaned.length === 0) {
        delete nextHooks[eventName]
      } else {
        nextHooks[eventName] = cleaned
      }
    }
    config.hooks = nextHooks
    writeHooksJson(configPath, config)
    return this.getStatus()
  }
}

export const claudeHookService = new ClaudeHookService()
