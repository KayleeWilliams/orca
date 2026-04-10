// ─── Explicit agent status (reported via OSC 9999 escape sequences) ─────────
// These types define the structured status that agents report at meaningful
// checkpoints. They are distinct from the heuristic `AgentStatus` inferred
// from terminal titles in agent-status.ts.

export type AgentStatusState = 'working' | 'blocked' | 'waiting' | 'done'
export type AgentType = 'claude' | 'codex' | 'gemini' | 'opencode' | 'aider' | 'unknown'

export type AgentStatusEntry = {
  state: AgentStatusState
  /** Short description of what the agent is currently doing. */
  summary: string
  /** Short description of what the agent plans to do next. */
  next: string
  /** Timestamp (ms) of the last status update. */
  updatedAt: number
  /** Whether this entry was reported explicitly by the agent or inferred from heuristics. */
  source: 'agent' | 'heuristic'
  agentType?: AgentType
  /** Composite key: `${tabId}:${paneId}` — matches the cacheTimerByKey convention. */
  paneKey: string
  terminalTitle?: string
}

// ─── OSC 9999 payload shape (what the agent actually prints) ────────────────
// The agent only needs to provide state, summary, and next. The remaining
// AgentStatusEntry fields (updatedAt, source, paneKey, etc.) are populated
// by the renderer when it parses the OSC sequence.

export type AgentStatusOscPayload = {
  state: AgentStatusState
  summary?: string
  next?: string
  agentType?: AgentType
}

/** Maximum character length for summary and next fields. Truncated on parse. */
export const AGENT_STATUS_MAX_FIELD_LENGTH = 200
/**
 * Freshness threshold for explicit agent status. After this point the hover still
 * shows the last reported summary, but heuristic state regains precedence for
 * ordering and coarse status so stale "done" reports do not mask live prompts.
 */
export const AGENT_STATUS_STALE_AFTER_MS = 30 * 60 * 1000

const VALID_STATES = new Set<AgentStatusState>(['working', 'blocked', 'waiting', 'done'])
const VALID_AGENT_TYPES = new Set<AgentType>([
  'claude',
  'codex',
  'gemini',
  'opencode',
  'aider',
  'unknown'
])

/** Normalize a status field: trim, collapse to single line, truncate. */
function normalizeField(value: unknown): string {
  if (typeof value !== 'string') {
    return ''
  }
  const singleLine = value.trim().replace(/[\r\n]+/g, ' ')
  return singleLine.length > AGENT_STATUS_MAX_FIELD_LENGTH
    ? singleLine.slice(0, AGENT_STATUS_MAX_FIELD_LENGTH)
    : singleLine
}

/**
 * Parse and validate an OSC 9999 JSON payload. Returns null if the payload
 * is malformed or has an invalid state.
 */
export function parseAgentStatusPayload(json: string): AgentStatusOscPayload | null {
  try {
    const parsed = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null) {
      return null
    }
    const state = parsed.state as string
    if (!VALID_STATES.has(state as AgentStatusState)) {
      return null
    }
    return {
      state: state as AgentStatusState,
      summary: normalizeField(parsed.summary),
      next: normalizeField(parsed.next),
      agentType: VALID_AGENT_TYPES.has(parsed.agentType as AgentType)
        ? (parsed.agentType as AgentType)
        : undefined
    }
  } catch {
    return null
  }
}
