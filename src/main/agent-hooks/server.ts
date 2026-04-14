import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { randomUUID } from 'crypto'
import {
  parseAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../shared/agent-status-types'

type AgentHookSource = 'claude' | 'codex'

type AgentHookEventPayload = {
  paneKey: string
  payload: ParsedAgentStatusPayload
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8')
      if (body.length > 1_000_000) {
        reject(new Error('payload too large'))
        req.destroy()
      }
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

function normalizeClaudeEvent(eventName: unknown): ParsedAgentStatusPayload | null {
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
      summary:
        state === 'waiting'
          ? 'Waiting for permission'
          : state === 'done'
            ? 'Turn complete'
            : 'Responding to prompt',
      agentType: 'claude'
    })
  )
}

function normalizeCodexEvent(eventName: unknown): ParsedAgentStatusPayload | null {
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
      summary:
        state === 'waiting'
          ? 'Waiting for permission'
          : state === 'done'
            ? 'Turn complete'
            : 'Responding to prompt',
      agentType: 'codex'
    })
  )
}

function normalizeHookPayload(
  source: AgentHookSource,
  body: unknown
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

  const eventName = (hookPayload as Record<string, unknown>).hook_event_name
  const payload =
    source === 'claude' ? normalizeClaudeEvent(eventName) : normalizeCodexEvent(eventName)

  return payload ? { paneKey, payload } : null
}

export class AgentHookServer {
  private server: ReturnType<typeof createServer> | null = null
  private port = 0
  private token = ''
  private onAgentStatus: ((payload: AgentHookEventPayload) => void) | null = null

  setListener(listener: ((payload: AgentHookEventPayload) => void) | null): void {
    this.onAgentStatus = listener
  }

  async start(): Promise<void> {
    if (this.server) {
      return
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

      try {
        const body = await readJsonBody(req)
        const source =
          req.url === '/hook/claude' ? 'claude' : req.url === '/hook/codex' ? 'codex' : null
        if (!source) {
          res.writeHead(404)
          res.end()
          return
        }

        const payload = normalizeHookPayload(source, body)
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
      this.server!.once('error', reject)
      this.server!.listen(0, '127.0.0.1', () => {
        const address = this.server!.address()
        if (address && typeof address === 'object') {
          this.port = address.port
        }
        resolve()
      })
    })
  }

  stop(): void {
    this.server?.close()
    this.server = null
    this.port = 0
    this.token = ''
    this.onAgentStatus = null
  }

  buildPtyEnv(): Record<string, string> {
    if (this.port <= 0 || !this.token) {
      return {}
    }

    return {
      ORCA_AGENT_HOOK_PORT: String(this.port),
      ORCA_AGENT_HOOK_TOKEN: this.token
    }
  }
}

export const agentHookServer = new AgentHookServer()
