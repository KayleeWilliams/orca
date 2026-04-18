#!/usr/bin/env node
/* eslint-disable max-lines -- Why: the public CLI entrypoint keeps command dispatch in one place so the bundled shell command and development fallback stay behaviorally identical. */

import { isAbsolute, relative, resolve as resolvePath } from 'path'
import type {
  CliStatusResult,
  RuntimeRepoList,
  RuntimeRepoSearchRefs,
  RuntimeWorktreeRecord,
  RuntimeWorktreePsResult,
  RuntimeWorktreeListResult,
  RuntimeTerminalRead,
  RuntimeTerminalListResult,
  RuntimeTerminalShow,
  RuntimeTerminalSend,
  RuntimeTerminalWait,
  BrowserSnapshotResult,
  BrowserClickResult,
  BrowserGotoResult,
  BrowserFillResult,
  BrowserTypeResult,
  BrowserSelectResult,
  BrowserScrollResult,
  BrowserBackResult,
  BrowserReloadResult,
  BrowserScreenshotResult,
  BrowserEvalResult,
  BrowserTabListResult,
  BrowserTabSwitchResult,
  BrowserHoverResult,
  BrowserDragResult,
  BrowserUploadResult,
  BrowserWaitResult,
  BrowserCheckResult,
  BrowserFocusResult,
  BrowserClearResult,
  BrowserSelectAllResult,
  BrowserKeypressResult,
  BrowserPdfResult,
  BrowserCookieGetResult,
  BrowserCookieSetResult,
  BrowserCookieDeleteResult,
  BrowserViewportResult,
  BrowserGeolocationResult,
  BrowserTimezoneResult,
  BrowserLocaleResult,
  BrowserPermissionResult,
  BrowserInterceptEnableResult,
  BrowserInterceptDisableResult,
  BrowserInterceptedRequest,
  BrowserInterceptContinueResult,
  BrowserInterceptBlockResult,
  BrowserCaptureStartResult,
  BrowserCaptureStopResult,
  BrowserConsoleResult,
  BrowserNetworkLogResult
} from '../shared/runtime-types'
import {
  RuntimeClient,
  RuntimeClientError,
  RuntimeRpcFailureError,
  type RuntimeRpcSuccess
} from './runtime-client'
import type { RuntimeRpcFailure } from './runtime-client'

type ParsedArgs = {
  commandPath: string[]
  flags: Map<string, string | boolean>
}

type CommandSpec = {
  path: string[]
  summary: string
  usage: string
  allowedFlags: string[]
  examples?: string[]
  notes?: string[]
}

const DEFAULT_TERMINAL_WAIT_RPC_TIMEOUT_MS = 5 * 60 * 1000
const GLOBAL_FLAGS = ['help', 'json']
export const COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['open'],
    summary: 'Launch Orca and wait for the runtime to be reachable',
    usage: 'orca open [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca open', 'orca open --json']
  },
  {
    path: ['status'],
    summary: 'Show app/runtime/graph readiness',
    usage: 'orca status [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca status', 'orca status --json']
  },
  {
    path: ['repo', 'list'],
    summary: 'List repos registered in Orca',
    usage: 'orca repo list [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['repo', 'add'],
    summary: 'Add a repo to Orca by filesystem path',
    usage: 'orca repo add --path <path> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'path']
  },
  {
    path: ['repo', 'show'],
    summary: 'Show one registered repo',
    usage: 'orca repo show --repo <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo']
  },
  {
    path: ['repo', 'set-base-ref'],
    summary: "Set the repo's default base ref for future worktrees",
    usage: 'orca repo set-base-ref --repo <selector> --ref <ref> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'ref']
  },
  {
    path: ['repo', 'search-refs'],
    summary: 'Search branch/tag refs within a repo',
    usage: 'orca repo search-refs --repo <selector> --query <text> [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'query', 'limit']
  },
  {
    path: ['worktree', 'list'],
    summary: 'List Orca-managed worktrees',
    usage: 'orca worktree list [--repo <selector>] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'limit']
  },
  {
    path: ['worktree', 'show'],
    summary: 'Show one worktree',
    usage: 'orca worktree show --worktree <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree']
  },
  {
    path: ['worktree', 'current'],
    summary: 'Show the Orca-managed worktree for the current directory',
    usage: 'orca worktree current [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Resolves the current shell directory to a path: selector so agents can target the enclosing Orca worktree without spelling out $PWD.'
    ],
    examples: ['orca worktree current', 'orca worktree current --json']
  },
  {
    path: ['worktree', 'create'],
    summary: 'Create a new Orca-managed worktree',
    usage:
      'orca worktree create --repo <selector> --name <name> [--base-branch <ref>] [--issue <number>] [--comment <text>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'name', 'base-branch', 'issue', 'comment'],
    notes: ['By default this matches the Orca UI flow and activates the new worktree in the app.']
  },
  {
    path: ['worktree', 'set'],
    summary: 'Update Orca metadata for a worktree',
    usage:
      'orca worktree set --worktree <selector> [--display-name <name>] [--issue <number|null>] [--comment <text>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'display-name', 'issue', 'comment']
  },
  {
    path: ['worktree', 'rm'],
    summary: 'Remove a worktree from Orca and git',
    usage: 'orca worktree rm --worktree <selector> [--force] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'force']
  },
  {
    path: ['worktree', 'ps'],
    summary: 'Show a compact orchestration summary across worktrees',
    usage: 'orca worktree ps [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'limit']
  },
  {
    path: ['terminal', 'list'],
    summary: 'List live Orca-managed terminals',
    usage: 'orca terminal list [--worktree <selector>] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'limit']
  },
  {
    path: ['terminal', 'show'],
    summary: 'Show terminal metadata and preview',
    usage: 'orca terminal show --terminal <handle> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal']
  },
  {
    path: ['terminal', 'read'],
    summary: 'Read bounded terminal output',
    usage: 'orca terminal read --terminal <handle> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal']
  },
  {
    path: ['terminal', 'send'],
    summary: 'Send input to a live terminal',
    usage:
      'orca terminal send --terminal <handle> [--text <text>] [--enter] [--interrupt] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'text', 'enter', 'interrupt']
  },
  {
    path: ['terminal', 'wait'],
    summary: 'Wait for a terminal condition',
    usage: 'orca terminal wait --terminal <handle> --for exit [--timeout-ms <ms>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'for', 'timeout-ms']
  },
  {
    path: ['terminal', 'stop'],
    summary: 'Stop terminals for a worktree',
    usage: 'orca terminal stop --worktree <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree']
  },
  // ── Browser automation ──
  {
    path: ['snapshot'],
    summary: 'Capture an accessibility snapshot of the active browser tab',
    usage: 'orca snapshot [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['screenshot'],
    summary: 'Capture a viewport screenshot of the active browser tab',
    usage: 'orca screenshot [--format <png|jpeg>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'format']
  },
  {
    path: ['click'],
    summary: 'Click a browser element by ref',
    usage: 'orca click --element <ref> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'element']
  },
  {
    path: ['fill'],
    summary: 'Clear and fill a browser input by ref',
    usage: 'orca fill --element <ref> --value <text> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'element', 'value']
  },
  {
    path: ['type'],
    summary: 'Type text at the current browser focus',
    usage: 'orca type --input <text> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'input']
  },
  {
    path: ['select'],
    summary: 'Select a dropdown option by ref',
    usage: 'orca select --element <ref> --value <value> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'element', 'value']
  },
  {
    path: ['scroll'],
    summary: 'Scroll the browser viewport',
    usage: 'orca scroll --direction <up|down> [--amount <pixels>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'direction', 'amount']
  },
  {
    path: ['goto'],
    summary: 'Navigate the active browser tab to a URL',
    usage: 'orca goto --url <url> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'url']
  },
  {
    path: ['back'],
    summary: 'Navigate back in browser history',
    usage: 'orca back [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['reload'],
    summary: 'Reload the active browser tab',
    usage: 'orca reload [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['eval'],
    summary: 'Evaluate JavaScript in the browser page context',
    usage: 'orca eval --expression <js> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'expression']
  },
  {
    path: ['wait'],
    summary: 'Wait for network idle',
    usage: 'orca wait [--timeout <ms>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'timeout']
  },
  {
    path: ['check'],
    summary: 'Check or uncheck a checkbox/radio by ref',
    usage: 'orca check --element <ref> [--uncheck] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'element', 'uncheck']
  },
  {
    path: ['focus'],
    summary: 'Focus a browser element by ref',
    usage: 'orca focus --element <ref> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'element']
  },
  {
    path: ['clear'],
    summary: 'Clear an input element by ref',
    usage: 'orca clear --element <ref> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'element']
  },
  {
    path: ['select-all'],
    summary: 'Select all text in an input by ref',
    usage: 'orca select-all --element <ref> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'element']
  },
  {
    path: ['keypress'],
    summary: 'Press a key (Enter, Tab, Escape, ArrowDown, etc.)',
    usage: 'orca keypress --key <name> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'key']
  },
  {
    path: ['pdf'],
    summary: 'Export the active browser tab as PDF',
    usage: 'orca pdf [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['full-screenshot'],
    summary: 'Capture a full-page screenshot (beyond viewport)',
    usage: 'orca full-screenshot [--format <png|jpeg>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'format']
  },
  {
    path: ['hover'],
    summary: 'Hover over a browser element by ref',
    usage: 'orca hover --element <ref> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'element']
  },
  {
    path: ['drag'],
    summary: 'Drag from one element to another',
    usage: 'orca drag --from <ref> --to <ref> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'from', 'to']
  },
  {
    path: ['upload'],
    summary: 'Upload files to a file input element',
    usage: 'orca upload --element <ref> --files <path,...> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'element', 'files']
  },
  {
    path: ['tab', 'list'],
    summary: 'List open browser tabs',
    usage: 'orca tab list [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['tab', 'switch'],
    summary: 'Switch the active browser tab',
    usage: 'orca tab switch --index <n> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'index']
  },
  // ── Cookie management ──
  {
    path: ['cookie', 'get'],
    summary: 'Get cookies for the active tab (optionally filter by URL)',
    usage: 'orca cookie get [--url <url>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'url']
  },
  {
    path: ['cookie', 'set'],
    summary: 'Set a cookie',
    usage:
      'orca cookie set --name <n> --value <v> [--domain <d>] [--path <p>] [--secure] [--httpOnly] [--sameSite <s>] [--expires <epoch>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'name',
      'value',
      'domain',
      'path',
      'secure',
      'httpOnly',
      'sameSite',
      'expires'
    ]
  },
  {
    path: ['cookie', 'delete'],
    summary: 'Delete a cookie by name',
    usage: 'orca cookie delete --name <n> [--domain <d>] [--url <u>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'name', 'domain', 'url']
  },
  // ── Viewport ──
  {
    path: ['viewport'],
    summary: 'Set browser viewport size',
    usage: 'orca viewport --width <w> --height <h> [--scale <n>] [--mobile] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'width', 'height', 'scale', 'mobile']
  },
  // ── Geolocation/timezone/locale ──
  {
    path: ['geolocation'],
    summary: 'Override browser geolocation',
    usage: 'orca geolocation --latitude <lat> --longitude <lon> [--accuracy <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'latitude', 'longitude', 'accuracy']
  },
  {
    path: ['timezone'],
    summary: 'Override browser timezone',
    usage: 'orca timezone --id <timezone> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id']
  },
  {
    path: ['locale'],
    summary: 'Override browser locale',
    usage: 'orca locale --locale <locale> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'locale']
  },
  // ── Permissions ──
  {
    path: ['permissions'],
    summary: 'Grant browser permissions (geolocation, notifications, etc.)',
    usage: 'orca permissions --grant <perm,...> [--origin <url>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'grant', 'origin']
  },
  // ── Request interception ──
  {
    path: ['intercept', 'enable'],
    summary: 'Enable request interception (pause matching requests)',
    usage: 'orca intercept enable [--patterns <glob,...>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'patterns']
  },
  {
    path: ['intercept', 'disable'],
    summary: 'Disable request interception',
    usage: 'orca intercept disable [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['intercept', 'list'],
    summary: 'List paused (intercepted) requests',
    usage: 'orca intercept list [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['intercept', 'continue'],
    summary: 'Continue a paused request',
    usage: 'orca intercept continue --id <requestId> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id']
  },
  {
    path: ['intercept', 'block'],
    summary: 'Block (fail) a paused request',
    usage: 'orca intercept block --id <requestId> [--reason <reason>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'reason']
  },
  // ── Console/network capture ──
  {
    path: ['capture', 'start'],
    summary: 'Start capturing console and network events',
    usage: 'orca capture start [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['capture', 'stop'],
    summary: 'Stop capturing console and network events',
    usage: 'orca capture stop [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['console'],
    summary: 'Show captured console log entries',
    usage: 'orca console [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'limit']
  },
  {
    path: ['network'],
    summary: 'Show captured network requests',
    usage: 'orca network [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'limit']
  }
]

export async function main(argv = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const parsed = parseArgs(argv)
  const helpPath = resolveHelpPath(parsed)
  if (helpPath !== null) {
    printHelp(helpPath)
    if (helpPath.length > 0 && !findCommandSpec(helpPath) && !isCommandGroup(helpPath)) {
      process.exitCode = 1
    }
    return
  }
  if (parsed.commandPath.length === 0) {
    printHelp([])
    return
  }
  const json = parsed.flags.has('json')

  try {
    // Why: CLI syntax and flag errors should be reported before any runtime
    // lookup so users do not get misleading "Orca is not running" failures for
    // simple command typos or unsupported flags.
    validateCommandAndFlags(parsed)

    const client = new RuntimeClient()
    const { commandPath } = parsed

    if (matches(commandPath, ['open'])) {
      const result = await client.openOrca()
      return printResult(result, json, formatCliStatus)
    }

    if (matches(commandPath, ['status'])) {
      const result = await client.getCliStatus()
      if (!json && !result.result.runtime.reachable) {
        process.exitCode = 1
      }
      return printResult(result, json, formatStatus)
    }

    if (matches(commandPath, ['repo', 'list'])) {
      const result = await client.call<RuntimeRepoList>('repo.list')
      return printResult(result, json, formatRepoList)
    }

    if (matches(commandPath, ['repo', 'add'])) {
      const result = await client.call<{ repo: Record<string, unknown> }>('repo.add', {
        path: getRequiredStringFlag(parsed.flags, 'path')
      })
      return printResult(result, json, formatRepoShow)
    }

    if (matches(commandPath, ['repo', 'show'])) {
      const result = await client.call<{ repo: Record<string, unknown> }>('repo.show', {
        repo: getRequiredStringFlag(parsed.flags, 'repo')
      })
      return printResult(result, json, formatRepoShow)
    }

    if (matches(commandPath, ['repo', 'set-base-ref'])) {
      const result = await client.call<{ repo: Record<string, unknown> }>('repo.setBaseRef', {
        repo: getRequiredStringFlag(parsed.flags, 'repo'),
        ref: getRequiredStringFlag(parsed.flags, 'ref')
      })
      return printResult(result, json, formatRepoShow)
    }

    if (matches(commandPath, ['repo', 'search-refs'])) {
      const result = await client.call<RuntimeRepoSearchRefs>('repo.searchRefs', {
        repo: getRequiredStringFlag(parsed.flags, 'repo'),
        query: getRequiredStringFlag(parsed.flags, 'query'),
        limit: getOptionalPositiveIntegerFlag(parsed.flags, 'limit')
      })
      return printResult(result, json, formatRepoRefs)
    }

    if (matches(commandPath, ['terminal', 'list'])) {
      const result = await client.call<RuntimeTerminalListResult>('terminal.list', {
        worktree: await getOptionalWorktreeSelector(parsed.flags, 'worktree', cwd, client),
        limit: getOptionalPositiveIntegerFlag(parsed.flags, 'limit')
      })
      return printResult(result, json, formatTerminalList)
    }

    if (matches(commandPath, ['terminal', 'show'])) {
      const result = await client.call<{ terminal: RuntimeTerminalShow }>('terminal.show', {
        terminal: getRequiredStringFlag(parsed.flags, 'terminal')
      })
      return printResult(result, json, formatTerminalShow)
    }

    if (matches(commandPath, ['terminal', 'read'])) {
      const result = await client.call<{ terminal: RuntimeTerminalRead }>('terminal.read', {
        terminal: getRequiredStringFlag(parsed.flags, 'terminal')
      })
      return printResult(result, json, formatTerminalRead)
    }

    if (matches(commandPath, ['terminal', 'send'])) {
      const result = await client.call<{ send: RuntimeTerminalSend }>('terminal.send', {
        terminal: getRequiredStringFlag(parsed.flags, 'terminal'),
        text: getOptionalStringFlag(parsed.flags, 'text'),
        enter: parsed.flags.get('enter') === true,
        interrupt: parsed.flags.get('interrupt') === true
      })
      return printResult(result, json, formatTerminalSend)
    }

    if (matches(commandPath, ['terminal', 'wait'])) {
      const timeoutMs = getOptionalPositiveIntegerFlag(parsed.flags, 'timeout-ms')
      const result = await client.call<{ wait: RuntimeTerminalWait }>(
        'terminal.wait',
        {
          terminal: getRequiredStringFlag(parsed.flags, 'terminal'),
          for: getRequiredStringFlag(parsed.flags, 'for'),
          timeoutMs
        },
        {
          // Why: terminal wait legitimately needs to outlive the CLI's default
          // RPC timeout. Even without an explicit server timeout, the client must
          // allow long waits instead of failing at the generic 15s transport cap.
          timeoutMs: timeoutMs ? timeoutMs + 5000 : DEFAULT_TERMINAL_WAIT_RPC_TIMEOUT_MS
        }
      )
      return printResult(result, json, formatTerminalWait)
    }

    if (matches(commandPath, ['terminal', 'stop'])) {
      const result = await client.call<{ stopped: number }>('terminal.stop', {
        worktree: await getRequiredWorktreeSelector(parsed.flags, 'worktree', cwd, client)
      })
      return printResult(result, json, (value) => `Stopped ${value.stopped} terminals.`)
    }

    if (matches(commandPath, ['worktree', 'ps'])) {
      const result = await client.call<RuntimeWorktreePsResult>('worktree.ps', {
        limit: getOptionalPositiveIntegerFlag(parsed.flags, 'limit')
      })
      return printResult(result, json, formatWorktreePs)
    }

    if (matches(commandPath, ['worktree', 'list'])) {
      const result = await client.call<RuntimeWorktreeListResult>('worktree.list', {
        repo: getOptionalStringFlag(parsed.flags, 'repo'),
        limit: getOptionalPositiveIntegerFlag(parsed.flags, 'limit')
      })
      return printResult(result, json, formatWorktreeList)
    }

    if (matches(commandPath, ['worktree', 'show'])) {
      const result = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
        worktree: await getRequiredWorktreeSelector(parsed.flags, 'worktree', cwd, client)
      })
      return printResult(result, json, formatWorktreeShow)
    }

    if (matches(commandPath, ['worktree', 'current'])) {
      const result = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
        worktree: await resolveCurrentWorktreeSelector(cwd, client)
      })
      return printResult(result, json, formatWorktreeShow)
    }

    if (matches(commandPath, ['worktree', 'create'])) {
      const result = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.create', {
        repo: getRequiredStringFlag(parsed.flags, 'repo'),
        name: getRequiredStringFlag(parsed.flags, 'name'),
        baseBranch: getOptionalStringFlag(parsed.flags, 'base-branch'),
        linkedIssue: getOptionalNumberFlag(parsed.flags, 'issue'),
        comment: getOptionalStringFlag(parsed.flags, 'comment')
      })
      return printResult(result, json, formatWorktreeShow)
    }

    if (matches(commandPath, ['worktree', 'set'])) {
      const result = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.set', {
        worktree: await getRequiredWorktreeSelector(parsed.flags, 'worktree', cwd, client),
        displayName: getOptionalStringFlag(parsed.flags, 'display-name'),
        linkedIssue: getOptionalNullableNumberFlag(parsed.flags, 'issue'),
        comment: getOptionalStringFlag(parsed.flags, 'comment')
      })
      return printResult(result, json, formatWorktreeShow)
    }

    if (matches(commandPath, ['worktree', 'rm'])) {
      const result = await client.call<{ removed: boolean }>('worktree.rm', {
        worktree: await getRequiredWorktreeSelector(parsed.flags, 'worktree', cwd, client),
        force: parsed.flags.get('force') === true
      })
      return printResult(result, json, (value) => `removed: ${value.removed}`)
    }

    // ── Browser automation dispatch ──

    if (matches(commandPath, ['snapshot'])) {
      const result = await client.call<BrowserSnapshotResult>('browser.snapshot')
      return printResult(result, json, formatSnapshot)
    }

    if (matches(commandPath, ['screenshot'])) {
      const format = getOptionalStringFlag(parsed.flags, 'format')
      const result = await client.call<BrowserScreenshotResult>('browser.screenshot', {
        format: format === 'jpeg' ? 'jpeg' : undefined
      })
      return printResult(result, json, formatScreenshot)
    }

    if (matches(commandPath, ['click'])) {
      const element = getRequiredStringFlag(parsed.flags, 'element')
      const result = await client.call<BrowserClickResult>('browser.click', { element })
      return printResult(result, json, (v) => `Clicked ${v.clicked}`)
    }

    if (matches(commandPath, ['fill'])) {
      const element = getRequiredStringFlag(parsed.flags, 'element')
      const value = getRequiredStringFlag(parsed.flags, 'value')
      const result = await client.call<BrowserFillResult>('browser.fill', { element, value })
      return printResult(result, json, (v) => `Filled ${v.filled}`)
    }

    if (matches(commandPath, ['type'])) {
      const input = getRequiredStringFlag(parsed.flags, 'input')
      const result = await client.call<BrowserTypeResult>('browser.type', { input })
      return printResult(result, json, () => 'Typed input')
    }

    if (matches(commandPath, ['select'])) {
      const element = getRequiredStringFlag(parsed.flags, 'element')
      const value = getRequiredStringFlag(parsed.flags, 'value')
      const result = await client.call<BrowserSelectResult>('browser.select', { element, value })
      return printResult(result, json, (v) => `Selected ${v.selected}`)
    }

    if (matches(commandPath, ['scroll'])) {
      const direction = getRequiredStringFlag(parsed.flags, 'direction')
      if (direction !== 'up' && direction !== 'down') {
        throw new RuntimeClientError('invalid_argument', '--direction must be "up" or "down"')
      }
      const amount = getOptionalPositiveIntegerFlag(parsed.flags, 'amount')
      const result = await client.call<BrowserScrollResult>('browser.scroll', {
        direction,
        amount
      })
      return printResult(result, json, (v) => `Scrolled ${v.scrolled}`)
    }

    if (matches(commandPath, ['goto'])) {
      const url = getRequiredStringFlag(parsed.flags, 'url')
      const result = await client.call<BrowserGotoResult>('browser.goto', { url })
      return printResult(result, json, (v) => `Navigated to ${v.url} — ${v.title}`)
    }

    if (matches(commandPath, ['back'])) {
      const result = await client.call<BrowserBackResult>('browser.back')
      return printResult(result, json, (v) => `Back to ${v.url} — ${v.title}`)
    }

    if (matches(commandPath, ['reload'])) {
      const result = await client.call<BrowserReloadResult>('browser.reload')
      return printResult(result, json, (v) => `Reloaded ${v.url} — ${v.title}`)
    }

    if (matches(commandPath, ['eval'])) {
      const expression = getRequiredStringFlag(parsed.flags, 'expression')
      const result = await client.call<BrowserEvalResult>('browser.eval', { expression })
      return printResult(result, json, (v) => v.value)
    }

    if (matches(commandPath, ['tab', 'list'])) {
      const result = await client.call<BrowserTabListResult>('browser.tabList')
      return printResult(result, json, formatTabList)
    }

    if (matches(commandPath, ['tab', 'switch'])) {
      const index = getOptionalNonNegativeIntegerFlag(parsed.flags, 'index')
      if (index === undefined) {
        throw new RuntimeClientError('invalid_argument', 'Missing required --index')
      }
      const result = await client.call<BrowserTabSwitchResult>('browser.tabSwitch', { index })
      return printResult(result, json, (v) => `Switched to tab ${v.switched}`)
    }

    if (matches(commandPath, ['wait'])) {
      const timeout = getOptionalPositiveIntegerFlag(parsed.flags, 'timeout')
      const result = await client.call<BrowserWaitResult>('browser.wait', { timeout })
      return printResult(result, json, () => 'Network idle')
    }

    if (matches(commandPath, ['check'])) {
      const element = getRequiredStringFlag(parsed.flags, 'element')
      const uncheck = parsed.flags.has('uncheck')
      const result = await client.call<BrowserCheckResult>('browser.check', {
        element,
        checked: !uncheck
      })
      return printResult(result, json, (v) =>
        v.checked ? `Checked ${element}` : `Unchecked ${element}`
      )
    }

    if (matches(commandPath, ['focus'])) {
      const element = getRequiredStringFlag(parsed.flags, 'element')
      const result = await client.call<BrowserFocusResult>('browser.focus', { element })
      return printResult(result, json, (v) => `Focused ${v.focused}`)
    }

    if (matches(commandPath, ['clear'])) {
      const element = getRequiredStringFlag(parsed.flags, 'element')
      const result = await client.call<BrowserClearResult>('browser.clear', { element })
      return printResult(result, json, (v) => `Cleared ${v.cleared}`)
    }

    if (matches(commandPath, ['select-all'])) {
      const element = getRequiredStringFlag(parsed.flags, 'element')
      const result = await client.call<BrowserSelectAllResult>('browser.selectAll', { element })
      return printResult(result, json, (v) => `Selected all in ${v.selected}`)
    }

    if (matches(commandPath, ['keypress'])) {
      const key = getRequiredStringFlag(parsed.flags, 'key')
      const result = await client.call<BrowserKeypressResult>('browser.keypress', { key })
      return printResult(result, json, (v) => `Pressed ${v.pressed}`)
    }

    if (matches(commandPath, ['pdf'])) {
      const result = await client.call<BrowserPdfResult>('browser.pdf')
      return printResult(
        result,
        json,
        () => `PDF exported (${result.result.data.length} bytes base64)`
      )
    }

    if (matches(commandPath, ['full-screenshot'])) {
      const format = (parsed.flags.get('format') as string) === 'jpeg' ? 'jpeg' : 'png'
      const result = await client.call<BrowserScreenshotResult>('browser.fullScreenshot', {
        format
      })
      return printResult(result, json, (v) => `Full-page screenshot captured (${v.format})`)
    }

    if (matches(commandPath, ['hover'])) {
      const element = getRequiredStringFlag(parsed.flags, 'element')
      const result = await client.call<BrowserHoverResult>('browser.hover', { element })
      return printResult(result, json, (v) => `Hovered ${v.hovered}`)
    }

    if (matches(commandPath, ['drag'])) {
      const from = getRequiredStringFlag(parsed.flags, 'from')
      const to = getRequiredStringFlag(parsed.flags, 'to')
      const result = await client.call<BrowserDragResult>('browser.drag', { from, to })
      return printResult(result, json, (v) => `Dragged ${v.dragged.from} → ${v.dragged.to}`)
    }

    if (matches(commandPath, ['upload'])) {
      const element = getRequiredStringFlag(parsed.flags, 'element')
      const filesStr = getRequiredStringFlag(parsed.flags, 'files')
      const files = filesStr.split(',').map((f) => f.trim())
      const result = await client.call<BrowserUploadResult>('browser.upload', { element, files })
      return printResult(result, json, (v) => `Uploaded ${v.uploaded} file(s)`)
    }

    // ── Cookie management ──

    if (matches(commandPath, ['cookie', 'get'])) {
      const url = getOptionalStringFlag(parsed.flags, 'url')
      const result = await client.call<BrowserCookieGetResult>('browser.cookie.get', { url })
      return printResult(result, json, (v) => {
        if (v.cookies.length === 0) {
          return 'No cookies'
        }
        return v.cookies.map((c) => `${c.name}=${c.value} (${c.domain})`).join('\n')
      })
    }

    if (matches(commandPath, ['cookie', 'set'])) {
      const name = getRequiredStringFlag(parsed.flags, 'name')
      const value = getRequiredStringFlag(parsed.flags, 'value')
      const params: Record<string, unknown> = { name, value }
      const domain = getOptionalStringFlag(parsed.flags, 'domain')
      const path = getOptionalStringFlag(parsed.flags, 'path')
      const sameSite = getOptionalStringFlag(parsed.flags, 'sameSite')
      const expires = getOptionalStringFlag(parsed.flags, 'expires')
      if (domain) {
        params.domain = domain
      }
      if (path) {
        params.path = path
      }
      if (parsed.flags.has('secure')) {
        params.secure = true
      }
      if (parsed.flags.has('httpOnly')) {
        params.httpOnly = true
      }
      if (sameSite) {
        params.sameSite = sameSite
      }
      if (expires) {
        params.expires = Number(expires)
      }
      const result = await client.call<BrowserCookieSetResult>('browser.cookie.set', params)
      return printResult(result, json, (v) =>
        v.success ? `Cookie "${name}" set` : `Failed to set cookie "${name}"`
      )
    }

    if (matches(commandPath, ['cookie', 'delete'])) {
      const name = getRequiredStringFlag(parsed.flags, 'name')
      const params: Record<string, unknown> = { name }
      const domain = getOptionalStringFlag(parsed.flags, 'domain')
      const url = getOptionalStringFlag(parsed.flags, 'url')
      if (domain) {
        params.domain = domain
      }
      if (url) {
        params.url = url
      }
      const result = await client.call<BrowserCookieDeleteResult>('browser.cookie.delete', params)
      return printResult(result, json, () => `Cookie "${name}" deleted`)
    }

    // ── Viewport ──

    if (matches(commandPath, ['viewport'])) {
      const width = Number(getRequiredStringFlag(parsed.flags, 'width'))
      const height = Number(getRequiredStringFlag(parsed.flags, 'height'))
      const params: Record<string, unknown> = { width, height }
      const scale = getOptionalStringFlag(parsed.flags, 'scale')
      if (scale) {
        params.deviceScaleFactor = Number(scale)
      }
      if (parsed.flags.has('mobile')) {
        params.mobile = true
      }
      const result = await client.call<BrowserViewportResult>('browser.viewport', params)
      return printResult(
        result,
        json,
        (v) => `Viewport set to ${v.width}×${v.height}${v.mobile ? ' (mobile)' : ''}`
      )
    }

    // ── Geolocation/timezone/locale ──

    if (matches(commandPath, ['geolocation'])) {
      const latitude = Number(getRequiredStringFlag(parsed.flags, 'latitude'))
      const longitude = Number(getRequiredStringFlag(parsed.flags, 'longitude'))
      const params: Record<string, unknown> = { latitude, longitude }
      const accuracy = getOptionalStringFlag(parsed.flags, 'accuracy')
      if (accuracy) {
        params.accuracy = Number(accuracy)
      }
      const result = await client.call<BrowserGeolocationResult>('browser.geolocation', params)
      return printResult(result, json, (v) => `Geolocation set to ${v.latitude}, ${v.longitude}`)
    }

    if (matches(commandPath, ['timezone'])) {
      const timezoneId = getRequiredStringFlag(parsed.flags, 'id')
      const result = await client.call<BrowserTimezoneResult>('browser.timezone', { timezoneId })
      return printResult(result, json, (v) => `Timezone set to ${v.timezoneId}`)
    }

    if (matches(commandPath, ['locale'])) {
      const locale = getRequiredStringFlag(parsed.flags, 'locale')
      const result = await client.call<BrowserLocaleResult>('browser.locale', { locale })
      return printResult(result, json, (v) => `Locale set to ${v.locale}`)
    }

    // ── Permissions ──

    if (matches(commandPath, ['permissions'])) {
      const grantStr = getRequiredStringFlag(parsed.flags, 'grant')
      const permissions = grantStr.split(',').map((p) => p.trim())
      const params: Record<string, unknown> = { permissions }
      const origin = getOptionalStringFlag(parsed.flags, 'origin')
      if (origin) {
        params.origin = origin
      }
      const result = await client.call<BrowserPermissionResult>('browser.permissions', params)
      return printResult(result, json, (v) => `Granted: ${v.granted.join(', ')}`)
    }

    // ── Request interception ──

    if (matches(commandPath, ['intercept', 'enable'])) {
      const params: Record<string, unknown> = {}
      const patternsStr = getOptionalStringFlag(parsed.flags, 'patterns')
      if (patternsStr) {
        params.patterns = patternsStr.split(',').map((p) => p.trim())
      }
      const result = await client.call<BrowserInterceptEnableResult>(
        'browser.intercept.enable',
        params
      )
      return printResult(result, json, (v) => `Interception enabled for: ${v.patterns.join(', ')}`)
    }

    if (matches(commandPath, ['intercept', 'disable'])) {
      const result = await client.call<BrowserInterceptDisableResult>('browser.intercept.disable')
      return printResult(result, json, () => 'Interception disabled')
    }

    if (matches(commandPath, ['intercept', 'list'])) {
      const result = await client.call<{ requests: BrowserInterceptedRequest[] }>(
        'browser.intercept.list'
      )
      return printResult(result, json, (v) => {
        if (v.requests.length === 0) {
          return 'No paused requests'
        }
        return v.requests
          .map((r) => `[${r.id}] ${r.method} ${r.url} (${r.resourceType})`)
          .join('\n')
      })
    }

    if (matches(commandPath, ['intercept', 'continue'])) {
      const requestId = getRequiredStringFlag(parsed.flags, 'id')
      const result = await client.call<BrowserInterceptContinueResult>(
        'browser.intercept.continue',
        { requestId }
      )
      return printResult(result, json, (v) => `Continued request ${v.continued}`)
    }

    if (matches(commandPath, ['intercept', 'block'])) {
      const requestId = getRequiredStringFlag(parsed.flags, 'id')
      const params: Record<string, unknown> = { requestId }
      const reason = getOptionalStringFlag(parsed.flags, 'reason')
      if (reason) {
        params.reason = reason
      }
      const result = await client.call<BrowserInterceptBlockResult>(
        'browser.intercept.block',
        params
      )
      return printResult(result, json, (v) => `Blocked request ${v.blocked}`)
    }

    // ── Console/network capture ──

    if (matches(commandPath, ['capture', 'start'])) {
      const result = await client.call<BrowserCaptureStartResult>('browser.capture.start')
      return printResult(result, json, () => 'Capture started (console + network)')
    }

    if (matches(commandPath, ['capture', 'stop'])) {
      const result = await client.call<BrowserCaptureStopResult>('browser.capture.stop')
      return printResult(result, json, () => 'Capture stopped')
    }

    if (matches(commandPath, ['console'])) {
      const params: Record<string, unknown> = {}
      const limit = getOptionalStringFlag(parsed.flags, 'limit')
      if (limit) {
        params.limit = Number(limit)
      }
      const result = await client.call<BrowserConsoleResult>('browser.console', params)
      return printResult(result, json, (v) => {
        if (v.entries.length === 0) {
          return 'No console entries'
        }
        return v.entries.map((e) => `[${e.level}] ${e.text}`).join('\n')
      })
    }

    if (matches(commandPath, ['network'])) {
      const params: Record<string, unknown> = {}
      const limit = getOptionalStringFlag(parsed.flags, 'limit')
      if (limit) {
        params.limit = Number(limit)
      }
      const result = await client.call<BrowserNetworkLogResult>('browser.network', params)
      return printResult(result, json, (v) => {
        if (v.entries.length === 0) {
          return 'No network entries'
        }
        return v.entries.map((e) => `${e.status} ${e.url} (${e.mimeType}, ${e.size}B)`).join('\n')
      })
    }

    throw new RuntimeClientError('invalid_argument', `Unknown command: ${commandPath.join(' ')}`)
  } catch (error) {
    if (json) {
      if (error instanceof RuntimeRpcFailureError) {
        console.log(JSON.stringify(error.response, null, 2))
      } else {
        const response: RuntimeRpcFailure = {
          id: 'local',
          ok: false,
          error: {
            code: error instanceof RuntimeClientError ? error.code : 'runtime_error',
            message: formatCliError(error)
          },
          _meta: {
            runtimeId: null
          }
        }
        console.log(JSON.stringify(response, null, 2))
      }
    } else {
      console.error(formatCliError(error))
    }
    process.exitCode = 1
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  const commandPath: string[] = []
  const flags = new Map<string, string | boolean>()

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      commandPath.push(token)
      continue
    }

    const flag = token.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      flags.set(flag, true)
      continue
    }
    flags.set(flag, next)
    i += 1
  }

  return { commandPath, flags }
}

export function resolveHelpPath(parsed: ParsedArgs): string[] | null {
  if (parsed.commandPath[0] === 'help') {
    return parsed.commandPath.slice(1)
  }
  if (parsed.flags.has('help')) {
    return parsed.commandPath
  }
  return null
}

export function validateCommandAndFlags(parsed: ParsedArgs): void {
  const spec = findCommandSpec(parsed.commandPath)
  if (!spec) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Unknown command: ${parsed.commandPath.join(' ')}`
    )
  }

  for (const flag of parsed.flags.keys()) {
    if (!spec.allowedFlags.includes(flag)) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Unknown flag --${flag} for command: ${spec.path.join(' ')}`
      )
    }
  }
}

export function findCommandSpec(commandPath: string[]): CommandSpec | undefined {
  return COMMAND_SPECS.find((spec) => matches(spec.path, commandPath))
}

function isCommandGroup(commandPath: string[]): boolean {
  return (
    commandPath.length === 1 && ['repo', 'worktree', 'terminal', 'tab'].includes(commandPath[0])
  )
}

function getRequiredStringFlag(flags: Map<string, string | boolean>, name: string): string {
  const value = flags.get(name)
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  throw new RuntimeClientError('invalid_argument', `Missing required --${name}`)
}

function getOptionalStringFlag(
  flags: Map<string, string | boolean>,
  name: string
): string | undefined {
  const value = flags.get(name)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function buildCurrentWorktreeSelector(cwd: string): string {
  return `path:${resolvePath(cwd)}`
}

export function normalizeWorktreeSelector(selector: string, cwd: string): string {
  if (selector === 'active' || selector === 'current') {
    return buildCurrentWorktreeSelector(cwd)
  }
  return selector
}

function isWithinPath(parentPath: string, childPath: string): boolean {
  const relativePath = relative(parentPath, childPath)
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

async function resolveCurrentWorktreeSelector(cwd: string, client: RuntimeClient): Promise<string> {
  const currentPath = resolvePath(cwd)
  const worktrees = await client.call<RuntimeWorktreeListResult>('worktree.list', {
    limit: 10_000
  })
  const enclosingWorktree = worktrees.result.worktrees
    .filter((worktree) => isWithinPath(resolvePath(worktree.path), currentPath))
    .sort((left, right) => right.path.length - left.path.length)[0]

  if (!enclosingWorktree) {
    throw new RuntimeClientError(
      'selector_not_found',
      `No Orca-managed worktree contains the current directory: ${currentPath}`
    )
  }

  // Why: users expect "active/current" to mean the enclosing managed worktree
  // even from nested subdirectories. The CLI resolves that shell-local concept
  // to the deepest matching worktree root, then hands the runtime a normal
  // path selector so selector semantics stay centralized in one layer.
  return buildCurrentWorktreeSelector(enclosingWorktree.path)
}

async function getOptionalWorktreeSelector(
  flags: Map<string, string | boolean>,
  name: string,
  cwd: string,
  client: RuntimeClient
): Promise<string | undefined> {
  const value = getOptionalStringFlag(flags, name)
  if (!value) {
    return undefined
  }
  if (value === 'active' || value === 'current') {
    return await resolveCurrentWorktreeSelector(cwd, client)
  }
  return normalizeWorktreeSelector(value, cwd)
}

async function getRequiredWorktreeSelector(
  flags: Map<string, string | boolean>,
  name: string,
  cwd: string,
  client: RuntimeClient
): Promise<string> {
  const value = getRequiredStringFlag(flags, name)
  if (value === 'active' || value === 'current') {
    return await resolveCurrentWorktreeSelector(cwd, client)
  }
  return normalizeWorktreeSelector(value, cwd)
}

function getOptionalNumberFlag(
  flags: Map<string, string | boolean>,
  name: string
): number | undefined {
  const value = flags.get(name)
  if (typeof value !== 'string' || value.length === 0) {
    return undefined
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new RuntimeClientError('invalid_argument', `Invalid numeric value for --${name}`)
  }
  return parsed
}

function getOptionalPositiveIntegerFlag(
  flags: Map<string, string | boolean>,
  name: string
): number | undefined {
  const value = getOptionalNumberFlag(flags, name)
  if (value === undefined) {
    return undefined
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new RuntimeClientError('invalid_argument', `Invalid positive integer for --${name}`)
  }
  return value
}

function getOptionalNonNegativeIntegerFlag(
  flags: Map<string, string | boolean>,
  name: string
): number | undefined {
  const value = getOptionalNumberFlag(flags, name)
  if (value === undefined) {
    return undefined
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new RuntimeClientError('invalid_argument', `Invalid non-negative integer for --${name}`)
  }
  return value
}

function getOptionalNullableNumberFlag(
  flags: Map<string, string | boolean>,
  name: string
): number | null | undefined {
  const value = flags.get(name)
  if (value === 'null') {
    return null
  }
  return getOptionalNumberFlag(flags, name)
}

export function matches(actual: string[], expected: string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  )
}

function printResult<TResult>(
  response: RuntimeRpcSuccess<TResult>,
  json: boolean,
  formatter: (value: TResult) => string
): void {
  if (json) {
    console.log(JSON.stringify(response, null, 2))
    return
  }
  console.log(formatter(response.result))
}

function formatStatus(status: CliStatusResult): string {
  return formatCliStatus(status)
}

function formatCliStatus(status: CliStatusResult): string {
  return [
    `appRunning: ${status.app.running}`,
    `pid: ${status.app.pid ?? 'none'}`,
    `runtimeState: ${status.runtime.state}`,
    `runtimeReachable: ${status.runtime.reachable}`,
    `runtimeId: ${status.runtime.runtimeId ?? 'none'}`,
    `graphState: ${status.graph.state}`
  ].join('\n')
}

function formatCliError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (
    error instanceof RuntimeClientError &&
    (error.code === 'runtime_unavailable' || error.code === 'runtime_timeout')
  ) {
    return `${message}\nOrca is not running. Run 'orca open' first.`
  }
  if (
    error instanceof RuntimeRpcFailureError &&
    error.response.error.code === 'runtime_unavailable'
  ) {
    return `${message}\nOrca is not running. Run 'orca open' first.`
  }
  return message
}

function formatTerminalList(result: RuntimeTerminalListResult): string {
  if (result.terminals.length === 0) {
    return 'No live terminals.'
  }
  const body = result.terminals
    .map(
      (terminal) =>
        `${terminal.handle}  ${terminal.title ?? '(untitled)'}  ${terminal.connected ? 'connected' : 'disconnected'}  ${terminal.worktreePath}\n${terminal.preview ? `preview: ${terminal.preview}` : 'preview: <empty>'}`
    )
    .join('\n\n')
  return result.truncated
    ? `${body}\n\ntruncated: showing ${result.terminals.length} of ${result.totalCount}`
    : body
}

function formatTerminalShow(result: { terminal: RuntimeTerminalShow }): string {
  const terminal = result.terminal
  return [
    `handle: ${terminal.handle}`,
    `title: ${terminal.title ?? '(untitled)'}`,
    `worktree: ${terminal.worktreePath}`,
    `branch: ${terminal.branch}`,
    `leaf: ${terminal.leafId}`,
    `ptyId: ${terminal.ptyId ?? 'none'}`,
    `connected: ${terminal.connected}`,
    `writable: ${terminal.writable}`,
    `preview: ${terminal.preview || '<empty>'}`
  ].join('\n')
}

function formatTerminalRead(result: { terminal: RuntimeTerminalRead }): string {
  const terminal = result.terminal
  return [`handle: ${terminal.handle}`, `status: ${terminal.status}`, '', ...terminal.tail].join(
    '\n'
  )
}

function formatTerminalSend(result: { send: RuntimeTerminalSend }): string {
  return `Sent ${result.send.bytesWritten} bytes to ${result.send.handle}.`
}

function formatTerminalWait(result: { wait: RuntimeTerminalWait }): string {
  return [
    `handle: ${result.wait.handle}`,
    `condition: ${result.wait.condition}`,
    `satisfied: ${result.wait.satisfied}`,
    `status: ${result.wait.status}`,
    `exitCode: ${result.wait.exitCode ?? 'null'}`
  ].join('\n')
}

function formatWorktreePs(result: RuntimeWorktreePsResult): string {
  if (result.worktrees.length === 0) {
    return 'No worktrees found.'
  }
  const body = result.worktrees
    .map(
      (worktree) =>
        `${worktree.repo} ${worktree.branch}  live:${worktree.liveTerminalCount}  pty:${worktree.hasAttachedPty ? 'yes' : 'no'}  unread:${worktree.unread ? 'yes' : 'no'}\n${worktree.path}${worktree.preview ? `\npreview: ${worktree.preview}` : ''}`
    )
    .join('\n\n')
  return result.truncated
    ? `${body}\n\ntruncated: showing ${result.worktrees.length} of ${result.totalCount}`
    : body
}

function formatRepoList(result: RuntimeRepoList): string {
  if (result.repos.length === 0) {
    return 'No repos found.'
  }
  return result.repos.map((repo) => `${repo.id}  ${repo.displayName}  ${repo.path}`).join('\n')
}

function formatRepoShow(result: { repo: Record<string, unknown> }): string {
  return Object.entries(result.repo)
    .map(
      ([key, value]) =>
        `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`
    )
    .join('\n')
}

function formatRepoRefs(result: RuntimeRepoSearchRefs): string {
  if (result.refs.length === 0) {
    return 'No refs found.'
  }
  return result.truncated ? `${result.refs.join('\n')}\n\ntruncated: yes` : result.refs.join('\n')
}

function formatWorktreeList(result: RuntimeWorktreeListResult): string {
  if (result.worktrees.length === 0) {
    return 'No worktrees found.'
  }
  const body = result.worktrees
    .map(
      (worktree) =>
        `${String(worktree.id)}  ${String(worktree.branch)}  ${String(worktree.path)}\ndisplayName: ${String(worktree.displayName ?? '')}\nlinkedIssue: ${String(worktree.linkedIssue ?? 'null')}\ncomment: ${String(worktree.comment ?? '')}`
    )
    .join('\n\n')
  return result.truncated
    ? `${body}\n\ntruncated: showing ${result.worktrees.length} of ${result.totalCount}`
    : body
}

function formatWorktreeShow(result: { worktree: RuntimeWorktreeRecord }): string {
  const worktree = result.worktree
  return Object.entries(worktree)
    .map(
      ([key, value]) =>
        `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`
    )
    .join('\n')
}

function formatSnapshot(result: BrowserSnapshotResult): string {
  const header = `${result.title} — ${result.url}\n`
  return header + result.snapshot
}

function formatScreenshot(result: BrowserScreenshotResult): string {
  return `Screenshot captured (${result.format}, ${Math.round(result.data.length * 0.75)} bytes)`
}

function formatTabList(result: BrowserTabListResult): string {
  if (result.tabs.length === 0) {
    return 'No browser tabs open.'
  }
  return result.tabs
    .map((t) => {
      const marker = t.active ? '* ' : '  '
      return `${marker}[${t.index}] ${t.title} — ${t.url}`
    })
    .join('\n')
}

function printHelp(commandPath: string[] = []): void {
  const exactSpec = findCommandSpec(commandPath)
  if (exactSpec) {
    console.log(formatCommandHelp(exactSpec))
    return
  }

  if (isCommandGroup(commandPath)) {
    console.log(formatGroupHelp(commandPath[0]))
    return
  }

  if (commandPath.length > 0) {
    console.log(`Unknown command: ${commandPath.join(' ')}\n`)
  }

  console.log(`orca

Usage: orca <command> [options]

Startup:
  open                      Launch Orca and wait for the runtime to be reachable
  status                    Show app/runtime/graph readiness

Repos:
  repo list                 List repos registered in Orca
  repo add                  Add a repo to Orca by filesystem path
  repo show                 Show one registered repo
  repo set-base-ref         Set the repo's default base ref for future worktrees
  repo search-refs          Search branch/tag refs within a repo

Worktrees:
  worktree list             List Orca-managed worktrees
  worktree show             Show one worktree
  worktree current          Show the Orca-managed worktree for the current directory
  worktree create           Create a new Orca-managed worktree
  worktree set              Update Orca metadata for a worktree
  worktree rm               Remove a worktree from Orca and git
  worktree ps               Show a compact orchestration summary across worktrees

Terminals:
  terminal list             List live Orca-managed terminals
  terminal show             Show terminal metadata and preview
  terminal read             Read bounded terminal output
  terminal send             Send input to a live terminal
  terminal wait             Wait for a terminal condition
  terminal stop             Stop terminals for a worktree

Browser:
  snapshot                  Capture an accessibility snapshot of the active browser tab
  screenshot                Capture a viewport screenshot of the active browser tab
  click                     Click a browser element by ref
  fill                      Clear and fill a browser input by ref
  type                      Type text at the current browser focus
  select                    Select a dropdown option by ref
  scroll                    Scroll the browser viewport
  goto                      Navigate the active browser tab to a URL
  back                      Navigate back in browser history
  reload                    Reload the active browser tab
  eval                      Evaluate JavaScript in the browser page context
  tab list                  List open browser tabs
  tab switch                Switch the active browser tab

Common Commands:
  orca open [--json]
  orca status [--json]
  orca worktree list [--repo <selector>] [--limit <n>] [--json]
  orca worktree create --repo <selector> --name <name> [--base-branch <ref>] [--issue <number>] [--comment <text>] [--json]
  orca worktree show --worktree <selector> [--json]
  orca worktree current [--json]
  orca worktree set --worktree <selector> [--display-name <name>] [--issue <number|null>] [--comment <text>] [--json]
  orca worktree rm --worktree <selector> [--force] [--json]
  orca worktree ps [--limit <n>] [--json]
  orca terminal list [--worktree <selector>] [--limit <n>] [--json]
  orca terminal show --terminal <handle> [--json]
  orca terminal read --terminal <handle> [--json]
  orca terminal send --terminal <handle> [--text <text>] [--enter] [--interrupt] [--json]
  orca terminal wait --terminal <handle> --for exit [--timeout-ms <ms>] [--json]
  orca terminal stop --worktree <selector> [--json]
  orca repo list [--json]
  orca repo add --path <path> [--json]
  orca repo show --repo <selector> [--json]
  orca repo set-base-ref --repo <selector> --ref <ref> [--json]
  orca repo search-refs --repo <selector> --query <text> [--limit <n>] [--json]

Selectors:
  --repo <selector>         Registered repo selector such as id:<id>, name:<name>, or path:<path>
  --worktree <selector>     Worktree selector such as id:<id>, branch:<branch>, issue:<number>, path:<path>, or active/current
  --terminal <handle>       Runtime-issued terminal handle returned by \`orca terminal list --json\`

Terminal Send Options:
  --text <text>             Text to send to the terminal
  --enter                   Append Enter after sending text
  --interrupt               Send as an interrupt-style input when supported

Wait Options:
  --for exit                Wait until the target terminal exits
  --timeout-ms <ms>         Maximum wait time before timing out

Output Options:
  --json                    Emit machine-readable JSON instead of human text
  --help                    Show this help message

Behavior:
  Most commands require a running Orca runtime. If Orca is not open yet, run \`orca open\` first.
  Use selectors for discovery and handles for repeated live terminal operations.

Examples:
  $ orca open
  $ orca status --json
  $ orca repo list
  $ orca worktree create --repo name:orca --name cli-test-1 --issue 273
  $ orca worktree show --worktree branch:Jinwoo-H/cli
  $ orca worktree current
  $ orca worktree set --worktree active --comment "waiting on review"
  $ orca worktree ps --limit 10
  $ orca terminal list --worktree path:/Users/me/orca/workspaces/orca/cli-test-1 --json
  $ orca terminal send --terminal term_123 --text "hi" --enter
  $ orca terminal wait --terminal term_123 --for exit --timeout-ms 60000 --json
  $ orca goto --url https://example.com
  $ orca snapshot
  $ orca click --element @e3
  $ orca fill --element @e5 --value "hello"
  $ orca tab list --json`)
}

function formatCommandHelp(spec: CommandSpec): string {
  const lines = [`orca ${spec.path.join(' ')}`, '', `Usage: ${spec.usage}`, '', spec.summary]

  if (spec.allowedFlags.length > 0) {
    lines.push('', 'Options:')
    for (const flag of spec.allowedFlags) {
      lines.push(`  ${formatFlagHelp(flag)}`)
    }
  }

  if (spec.notes && spec.notes.length > 0) {
    lines.push('', 'Notes:')
    for (const note of spec.notes) {
      lines.push(`  ${note}`)
    }
  }

  if (spec.examples && spec.examples.length > 0) {
    lines.push('', 'Examples:')
    for (const example of spec.examples) {
      lines.push(`  $ ${example}`)
    }
  }

  return lines.join('\n')
}

function formatGroupHelp(group: string): string {
  const specs = COMMAND_SPECS.filter((spec) => spec.path[0] === group)
  const lines = [`orca ${group}`, '', `Usage: orca ${group} <command> [options]`, '', 'Commands:']
  for (const spec of specs) {
    lines.push(`  ${spec.path.slice(1).join(' ').padEnd(18)} ${spec.summary}`)
  }
  lines.push('', `Run \`orca ${group} <command> --help\` for command-specific usage.`)
  return lines.join('\n')
}

function formatFlagHelp(flag: string): string {
  const helpByFlag: Record<string, string> = {
    'base-branch': '--base-branch <ref>    Base branch/ref to create the worktree from',
    comment: '--comment <text>       Comment stored in Orca metadata',
    'display-name': '--display-name <name>  Override the Orca display name',
    enter: '--enter                Append Enter after sending text',
    force: '--force                Force worktree removal when supported',
    for: '--for exit             Wait condition to satisfy',
    help: '--help                 Show this help message',
    interrupt: '--interrupt            Send as an interrupt-style input when supported',
    issue: '--issue <number|null>  Linked GitHub issue number',
    json: '--json                 Emit machine-readable JSON',
    limit: '--limit <n>            Maximum number of rows to return',
    name: '--name <name>          Name for the new worktree',
    path: '--path <path>          Filesystem path to the repo',
    query: '--query <text>        Search text for matching refs',
    ref: '--ref <ref>            Base ref to persist for the repo',
    repo: '--repo <selector>      Repo selector such as id:<id>, name:<name>, or path:<path>',
    terminal: '--terminal <handle>  Runtime-issued terminal handle',
    text: '--text <text>          Text to send to the terminal',
    'timeout-ms': '--timeout-ms <ms>     Maximum wait time before timing out',
    worktree:
      '--worktree <selector>  Worktree selector such as id:<id>, branch:<branch>, issue:<number>, path:<path>, or active/current',
    // Browser automation flags
    element: '--element <ref>        Element ref from snapshot (e.g. @e3)',
    url: '--url <url>            URL to navigate to',
    value: '--value <text>         Value to fill or select',
    input: '--input <text>         Text to type at current focus',
    expression: '--expression <js>     JavaScript expression to evaluate',
    direction: '--direction <up|down>  Scroll direction',
    amount: '--amount <pixels>      Scroll distance in pixels',
    index: '--index <n>            Tab index to switch to',
    format: '--format <png|jpeg>    Screenshot image format'
  }

  return helpByFlag[flag] ?? `--${flag}`
}

if (require.main === module) {
  void main()
}
