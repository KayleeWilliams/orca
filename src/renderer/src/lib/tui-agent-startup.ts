import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../shared/types'

export type AgentStartupPlan = {
  launchCommand: string
  expectedProcess: string
  followupPrompt: string | null
}

function quoteStartupArg(value: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return `"${value.replace(/"/g, '""')}"`
  }

  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function buildAgentStartupPlan(args: {
  agent: TuiAgent
  prompt: string
  cmdOverrides: Partial<Record<TuiAgent, string>>
  platform: NodeJS.Platform
  allowEmptyPromptLaunch?: boolean
}): AgentStartupPlan | null {
  const { agent, prompt, cmdOverrides, platform, allowEmptyPromptLaunch = false } = args
  const trimmedPrompt = prompt.trim()
  const config = TUI_AGENT_CONFIG[agent]
  const baseCommand = cmdOverrides[agent] ?? config.launchCmd

  if (!trimmedPrompt) {
    if (!allowEmptyPromptLaunch) {
      return null
    }
    return {
      launchCommand: baseCommand,
      expectedProcess: config.expectedProcess,
      followupPrompt: null
    }
  }

  const quotedPrompt = quoteStartupArg(trimmedPrompt, platform)

  if (config.promptInjectionMode === 'argv') {
    return {
      launchCommand: `${baseCommand} ${quotedPrompt}`,
      expectedProcess: config.expectedProcess,
      followupPrompt: null
    }
  }

  if (config.promptInjectionMode === 'flag-prompt') {
    return {
      launchCommand: `${baseCommand} --prompt ${quotedPrompt}`,
      expectedProcess: config.expectedProcess,
      followupPrompt: null
    }
  }

  if (config.promptInjectionMode === 'flag-prompt-interactive') {
    return {
      launchCommand: `${baseCommand} --prompt-interactive ${quotedPrompt}`,
      expectedProcess: config.expectedProcess,
      followupPrompt: null
    }
  }

  if (config.promptInjectionMode === 'flag-interactive') {
    return {
      launchCommand: `${baseCommand} -i ${quotedPrompt}`,
      expectedProcess: config.expectedProcess,
      followupPrompt: null
    }
  }

  return {
    launchCommand: baseCommand,
    expectedProcess: config.expectedProcess,
    // Why: several agent TUIs either lack a documented "start interactive
    // session with this prompt" flag or vary too much across versions. For
    // those agents Orca launches the TUI first, then types the composed prompt
    // into the live session once the agent owns the terminal.
    followupPrompt: trimmedPrompt
  }
}

export type AgentDraftLaunchPlan = {
  launchCommand: string
  expectedProcess: string
}

// Why: the "Use" direct-launch flow wants to open the agent TUI with the work
// item URL already in the input box, but NOT submitted. Some CLIs expose a
// native flag for exactly that (e.g. `claude --prefill '<text>'`), which is
// strictly better than the post-launch bracketed-paste fallback because it
// avoids the agent-readiness race and a 120ms settle. Returns null when the
// agent has no such flag — callers fall back to paste-after-start.
export function buildAgentDraftLaunchPlan(args: {
  agent: TuiAgent
  draft: string
  cmdOverrides: Partial<Record<TuiAgent, string>>
  platform: NodeJS.Platform
}): AgentDraftLaunchPlan | null {
  const { agent, draft, cmdOverrides, platform } = args
  const config = TUI_AGENT_CONFIG[agent]
  if (!config.draftPromptFlag) {
    return null
  }
  const trimmed = draft.trim()
  if (!trimmed) {
    return null
  }
  const baseCommand = cmdOverrides[agent] ?? config.launchCmd
  const quoted = quoteStartupArg(trimmed, platform)
  return {
    launchCommand: `${baseCommand} ${config.draftPromptFlag} ${quoted}`,
    expectedProcess: config.expectedProcess
  }
}

export function isShellProcess(processName: string): boolean {
  const normalized = processName.trim().toLowerCase()
  return (
    normalized === '' ||
    normalized === 'bash' ||
    normalized === 'zsh' ||
    normalized === 'sh' ||
    normalized === 'fish' ||
    normalized === 'cmd.exe' ||
    normalized === 'powershell.exe' ||
    normalized === 'pwsh.exe' ||
    normalized === 'nu'
  )
}
