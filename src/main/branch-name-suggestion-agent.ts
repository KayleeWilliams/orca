import { spawn } from 'child_process'
import type { TuiAgent } from '../shared/types'
import { gitExecFileAsync } from './git/runner'
import { sanitizeWorktreeName } from './ipc/worktree-logic'

export type SupportedNamingAgent = Extract<TuiAgent, 'claude' | 'codex' | 'gemini' | 'opencode'>

const SUPPORTED_AGENTS = new Set<string>(['claude', 'codex', 'gemini', 'opencode'])
const MAX_AGENT_STDOUT_BYTES = 16_000
const MAX_AGENT_STDERR_BYTES = 8_000
const MAX_DIFF_INPUT_CHARS = 80_000
const AGENT_TIMEOUT_MS = 30_000

function getAgentCommand(
  agent: SupportedNamingAgent,
  prompt: string
): { command: string; args: string[] } {
  if (agent === 'claude') {
    return { command: 'claude', args: ['-p', prompt] }
  }
  if (agent === 'codex') {
    return { command: 'codex', args: ['exec', prompt] }
  }
  if (agent === 'gemini') {
    return { command: 'gemini', args: ['-p', prompt] }
  }
  return { command: 'opencode', args: ['run', prompt] }
}

async function gitStdout(args: string[], cwd: string): Promise<string> {
  const { stdout } = await gitExecFileAsync(args, { cwd })
  return stdout.trim()
}

export function isSupportedNamingAgent(
  agentType: string | undefined
): agentType is SupportedNamingAgent {
  return !!agentType && SUPPORTED_AGENTS.has(agentType)
}

export async function buildAgentInput(worktreePath: string, baseRef: string): Promise<string> {
  const [commits, stat, patch] = await Promise.all([
    gitStdout(['log', '--format=%s', `${baseRef}..HEAD`], worktreePath).catch(() => ''),
    gitStdout(['diff', '--stat', `${baseRef}...HEAD`], worktreePath).catch(() => ''),
    gitStdout(
      ['diff', '--no-ext-diff', '--find-renames', '--unified=3', `${baseRef}...HEAD`],
      worktreePath
    ).catch(() => '')
  ])
  const input = `Commits:\n${commits}\n\nDiff stat:\n${stat}\n\nPatch:\n${patch}`
  return input.length > MAX_DIFF_INPUT_CHARS ? input.slice(0, MAX_DIFF_INPUT_CHARS) : input
}

export function buildPrompt(current: string): string {
  return [
    'Suggest one concise git branch leaf slug for this change.',
    `Current branch: ${current}`,
    'Use the commit subjects, diff stat, and patch provided on stdin.',
    'Return only the leaf slug, not a full branch path, no markdown, no explanation.',
    'Use lowercase words separated by hyphens. Keep it under 48 characters.'
  ].join('\n')
}

export function runAgent(
  agent: SupportedNamingAgent,
  prompt: string,
  stdin: string,
  cwd: string
): Promise<string> {
  const { command, args } = getAgentCommand(agent, prompt)
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      child.kill('SIGTERM')
      reject(new Error('branch naming agent timed out'))
    }, AGENT_TIMEOUT_MS)

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_AGENT_STDOUT_BYTES) {
        stdout += chunk.toString('utf8').slice(0, MAX_AGENT_STDOUT_BYTES - stdout.length)
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_AGENT_STDERR_BYTES) {
        stderr += chunk.toString('utf8').slice(0, MAX_AGENT_STDERR_BYTES - stderr.length)
      }
    })
    child.on('error', (error) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (code === 0) {
        resolve(stdout)
        return
      }
      reject(
        new Error(stderr.trim() || `branch naming agent exited with code ${code ?? 'unknown'}`)
      )
    })
    child.stdin.end(stdin)
  })
}

export function extractSlug(output: string): string {
  const line = output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean)
  if (!line) {
    throw new Error('branch naming agent returned no suggestion')
  }
  const unwrapped = line.replace(/^`+|`+$/g, '').replace(/^["']+|["']+$/g, '')
  return sanitizeWorktreeName(unwrapped.toLowerCase()).slice(0, 60)
}
