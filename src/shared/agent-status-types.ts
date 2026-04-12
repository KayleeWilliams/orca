// ─── Explicit agent status (reported via `orca status set` CLI → IPC) ───────
// These types define the structured status that agents report at meaningful
// checkpoints. They are distinct from the heuristic `AgentStatus` inferred
// from terminal titles in agent-status.ts.

export type AgentStatusState = 'working' | 'blocked' | 'waiting' | 'done'
export type AgentType = 'claude' | 'codex' | 'gemini' | 'opencode' | 'aider' | 'unknown'

/** A snapshot of a previous agent state, used to render activity blocks. */
export type AgentStateHistoryEntry = {
  state: AgentStatusState
  summary: string
  /** When this state was first reported. */
  startedAt: number
}

/** Maximum number of history entries kept per agent to bound memory. */
export const AGENT_STATE_HISTORY_MAX = 20

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
  /** Rolling log of previous states. Each entry records a state the agent was in
   *  before transitioning to the current one. Capped at AGENT_STATE_HISTORY_MAX. */
  stateHistory: AgentStateHistoryEntry[]
}

// ─── Agent status payload shape (what the CLI sends via IPC) ────────────────
// The agent only needs to provide state, summary, and next. The remaining
// AgentStatusEntry fields (updatedAt, source, paneKey, etc.) are populated
// by the renderer when it receives the IPC event.

export type AgentStatusPayload = {
  state: AgentStatusState
  summary?: string
  next?: string
  agentType?: AgentType
}

/**
 * The result of `parseAgentStatusPayload`: summary and next are always
 * normalized to strings (empty string when the raw payload omits them),
 * so consumers do not need nullish-coalescing on these fields.
 */
export type ParsedAgentStatusPayload = {
  state: AgentStatusState
  summary: string
  next: string
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
 * Parse and validate an agent status JSON payload (received via CLI/IPC or
 * OSC 9999). Returns null if the payload is malformed or has an invalid state.
 */
export function parseAgentStatusPayload(json: string): ParsedAgentStatusPayload | null {
  try {
    const parsed = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null) {
      return null
    }
    // Why: explicit typeof guard ensures non-string values (e.g. numbers)
    // are rejected rather than relying on Set.has returning false for
    // mismatched types.
    if (typeof parsed.state !== 'string') {
      return null
    }
    const state = parsed.state
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
