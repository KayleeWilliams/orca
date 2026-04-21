import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { randomUUID } from 'crypto'
import {
  parseAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../shared/agent-status-types'
import { ORCA_HOOK_PROTOCOL_VERSION } from '../../shared/agent-hook-types'

type AgentHookSource = 'claude' | 'codex' | 'gemini'

type AgentHookEventPayload = {
  paneKey: string
  tabId?: string
  worktreeId?: string
  payload: ParsedAgentStatusPayload
}

// Why: only log a given version/env mismatch once per process so a stale hook
// script that fires on every keystroke doesn't flood the logs.
const warnedVersions = new Set<string>()
const warnedEnvs = new Set<string>()

// Why: Claude documents `prompt` on UserPromptSubmit; other agents may use
// different field names. Probe a small allowlist so we can surface the real
// user prompt in the dashboard regardless of which agent is reporting.
function extractPromptText(hookPayload: Record<string, unknown>): string {
  const candidateKeys = ['prompt', 'user_prompt', 'userPrompt', 'message']
  for (const key of candidateKeys) {
    const value = hookPayload[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value
    }
  }
  return ''
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      // Why: check size before appending and return immediately after destroy
      // so we don't keep accumulating bytes after rejecting, which could let a
      // malicious client push memory usage well past the advertised limit.
      if (body.length + chunk.length > 1_000_000) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      body += chunk.toString('utf8')
    })
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

// Why: only UserPromptSubmit carries the user's prompt. Subsequent events in
// the same turn (PostToolUse, PermissionRequest, Stop, …) arrive with no
// prompt, so we cache the last prompt per pane and reuse it until a new
// prompt arrives. The cache survives across `done` so the user can still see
// what finished; it's reset on the next UserPromptSubmit.
const lastPromptByPaneKey = new Map<string, string>()

function resolvePrompt(paneKey: string, promptText: string): string {
  if (promptText) {
    lastPromptByPaneKey.set(paneKey, promptText)
    return promptText
  }
  return lastPromptByPaneKey.get(paneKey) ?? ''
}

function normalizeClaudeEvent(
  eventName: unknown,
  promptText: string,
  paneKey: string
): ParsedAgentStatusPayload | null {
  const state =
    eventName === 'UserPromptSubmit' ||
    eventName === 'PostToolUse' ||
    eventName === 'PostToolUseFailure'
      ? 'working'
      : eventName === 'PermissionRequest'
        ? 'waiting'
        : eventName === 'Stop'
          ? 'done'
          : null

  if (!state) {
    return null
  }

  return parseAgentStatusPayload(
    JSON.stringify({
      state,
      prompt: resolvePrompt(paneKey, promptText),
      agentType: 'claude'
    })
  )
}

// Why: Gemini CLI exposes BeforeAgent/AfterAgent/AfterTool hooks. BeforeAgent
// fires at turn start and AfterTool resumes the working state after a tool
// call completes; AfterAgent fires when the agent becomes idle. Gemini has no
// permission-prompt hook, so we cannot surface a waiting state for Gemini.
function normalizeGeminiEvent(
  eventName: unknown,
  promptText: string,
  paneKey: string
): ParsedAgentStatusPayload | null {
  const state =
    eventName === 'BeforeAgent' || eventName === 'AfterTool'
      ? 'working'
      : eventName === 'AfterAgent'
        ? 'done'
        : null

  if (!state) {
    return null
  }

  return parseAgentStatusPayload(
    JSON.stringify({
      state,
      prompt: resolvePrompt(paneKey, promptText),
      agentType: 'gemini'
    })
  )
}

function normalizeCodexEvent(
  eventName: unknown,
  promptText: string,
  paneKey: string
): ParsedAgentStatusPayload | null {
  const state =
    eventName === 'SessionStart' || eventName === 'UserPromptSubmit'
      ? 'working'
      : eventName === 'PreToolUse'
        ? 'waiting'
        : eventName === 'Stop'
          ? 'done'
          : null

  if (!state) {
    return null
  }

  return parseAgentStatusPayload(
    JSON.stringify({
      state,
      prompt: resolvePrompt(paneKey, promptText),
      agentType: 'codex'
    })
  )
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeHookPayload(
  source: AgentHookSource,
  body: unknown,
  expectedEnv: string
): AgentHookEventPayload | null {
  if (typeof body !== 'object' || body === null) {
    return null
  }

  const record = body as Record<string, unknown>
  const paneKey = typeof record.paneKey === 'string' ? record.paneKey.trim() : ''
  const hookPayload = record.payload
  if (!paneKey || typeof hookPayload !== 'object' || hookPayload === null) {
    return null
  }

  // Why: scripts installed by an older app build may send a different shape.
  // We accept the request (fail-open) but log once so stale installs are
  // diagnosable instead of silently degrading.
  const version = readStringField(record, 'version')
  if (version && version !== ORCA_HOOK_PROTOCOL_VERSION && !warnedVersions.has(version)) {
    warnedVersions.add(version)
    console.warn(
      `[agent-hooks] received hook v${version}; server expects v${ORCA_HOOK_PROTOCOL_VERSION}. ` +
        'Reinstall agent hooks from Settings to upgrade the managed script.'
    )
  }

  // Why: detects dev-vs-prod cross-talk. A hook installed by a dev build but
  // triggered inside a prod terminal (or vice versa) still points at whichever
  // loopback port the shell env captured, so the *other* instance may receive
  // it. Logging the mismatch lets a user know their terminals are wired to the
  // wrong Orca.
  const clientEnv = readStringField(record, 'env')
  if (clientEnv && clientEnv !== expectedEnv) {
    const key = `${clientEnv}->${expectedEnv}`
    if (!warnedEnvs.has(key)) {
      warnedEnvs.add(key)
      console.warn(
        `[agent-hooks] received ${clientEnv} hook on ${expectedEnv} server. ` +
          'Likely a stale terminal from another Orca install.'
      )
    }
  }

  const tabId = readStringField(record, 'tabId')
  const worktreeId = readStringField(record, 'worktreeId')

  const eventName = (hookPayload as Record<string, unknown>).hook_event_name
  const promptText = extractPromptText(hookPayload as Record<string, unknown>)
  console.log('[agent-hooks:server] incoming', {
    source,
    paneKey,
    tabId,
    worktreeId,
    eventName,
    promptTextLen: promptText.length,
    promptPreview: promptText.slice(0, 80),
    cachedPrompt: lastPromptByPaneKey.get(paneKey)?.slice(0, 80) ?? null,
    hookPayloadKeys: Object.keys(hookPayload as Record<string, unknown>)
  })
  const payload =
    source === 'claude'
      ? normalizeClaudeEvent(eventName, promptText, paneKey)
      : source === 'codex'
        ? normalizeCodexEvent(eventName, promptText, paneKey)
        : normalizeGeminiEvent(eventName, promptText, paneKey)

  console.log('[agent-hooks:server] normalized', {
    paneKey,
    payload: payload
      ? {
          state: payload.state,
          promptLen: payload.prompt.length,
          prompt: payload.prompt.slice(0, 80)
        }
      : null
  })
  return payload ? { paneKey, tabId, worktreeId, payload } : null
}

export class AgentHookServer {
  private server: ReturnType<typeof createServer> | null = null
  private port = 0
  private token = ''
  // Why: identifies this Orca instance so hook scripts can stamp requests and
  // the server can detect dev vs. prod cross-talk. Set at start() from the
  // caller's knowledge of whether this is a packaged build.
  private env = 'production'
  private onAgentStatus: ((payload: AgentHookEventPayload) => void) | null = null

  setListener(listener: ((payload: AgentHookEventPayload) => void) | null): void {
    this.onAgentStatus = listener
  }

  async start(options?: { env?: string }): Promise<void> {
    if (this.server) {
      return
    }

    if (options?.env) {
      this.env = options.env
    }
    this.token = randomUUID()
    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        res.writeHead(404)
        res.end()
        return
      }

      if (req.headers['x-orca-agent-hook-token'] !== this.token) {
        res.writeHead(403)
        res.end()
        return
      }

      // Why: bound request time so a slow/stalled client cannot hold a socket
      // open indefinitely (slowloris-style). The hook endpoints are local and
      // should complete in well under a second.
      req.setTimeout(5000, () => {
        req.destroy()
      })

      try {
        const body = await readJsonBody(req)
        const source: AgentHookSource | null =
          req.url === '/hook/claude'
            ? 'claude'
            : req.url === '/hook/codex'
              ? 'codex'
              : req.url === '/hook/gemini'
                ? 'gemini'
                : null
        if (!source) {
          res.writeHead(404)
          res.end()
          return
        }

        const payload = normalizeHookPayload(source, body, this.env)
        if (payload) {
          this.onAgentStatus?.(payload)
        }

        res.writeHead(204)
        res.end()
      } catch {
        // Why: agent hooks must fail open. The receiver returns success for
        // malformed payloads so a newer or broken hook never blocks the agent.
        res.writeHead(204)
        res.end()
      }
    })

    await new Promise<void>((resolve, reject) => {
      // Why: the startup error handler must only reject the start() promise for
      // errors that happen before 'listening'. Without swapping it out on
      // success, any later runtime error (e.g. EADDRINUSE during rebind,
      // socket errors) would call reject() on an already-settled promise and,
      // more importantly, leaving it as the only 'error' listener means node
      // treats runtime errors as unhandled and crashes the main process.
      const onStartupError = (err: Error): void => {
        this.server?.off('listening', onListening)
        reject(err)
      }
      const onListening = (): void => {
        this.server?.off('error', onStartupError)
        this.server?.on('error', (err) => {
          console.error('[agent-hooks] server error', err)
        })
        const address = this.server!.address()
        if (address && typeof address === 'object') {
          this.port = address.port
        }
        resolve()
      }
      this.server!.once('error', onStartupError)
      this.server!.listen(0, '127.0.0.1', onListening)
    })
  }

  stop(): void {
    this.server?.close()
    this.server = null
    this.port = 0
    this.token = ''
    this.env = 'production'
    this.onAgentStatus = null
  }

  buildPtyEnv(): Record<string, string> {
    if (this.port <= 0 || !this.token) {
      return {}
    }

    return {
      ORCA_AGENT_HOOK_PORT: String(this.port),
      ORCA_AGENT_HOOK_TOKEN: this.token,
      ORCA_AGENT_HOOK_ENV: this.env,
      ORCA_AGENT_HOOK_VERSION: ORCA_HOOK_PROTOCOL_VERSION
    }
  }
}

export const agentHookServer = new AgentHookServer()
