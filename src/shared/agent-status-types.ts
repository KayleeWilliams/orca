// ─── Explicit agent status (reported via native agent hooks → IPC) ──────────
// These types define the normalized status that Orca receives from Claude,
// Codex, and other explicit integrations. Agent state is hook-reported only —
// we do not infer status from terminal titles anywhere in the data flow.

export type AgentStatusState = 'working' | 'blocked' | 'waiting' | 'done'
// Why: agent types are not restricted to a fixed set — new agents appear
// regularly and users may run custom agents. Any non-empty string is accepted;
// well-known names are kept as a convenience union for internal code that
// wants to pattern-match on common agents.
export type WellKnownAgentType = 'claude' | 'codex' | 'gemini' | 'opencode' | 'aider' | 'unknown'
export type AgentType = WellKnownAgentType | (string & {})

/** A snapshot of a previous agent state, used to render activity blocks. */
export type AgentStateHistoryEntry = {
  state: AgentStatusState
  prompt: string
  /** When this state was first reported. */
  startedAt: number
  /** True when this `done` was a cancellation (user hit ESC/Ctrl+C). Reported
   *  by the agent itself — Claude Code sets `is_interrupt: true` on its `Stop`
   *  hook when the turn ended via interrupt. Always falsy for non-`done`
   *  states, so retention logic can preserve this signal. */
  interrupted?: boolean
}

/** Maximum number of history entries kept per agent to bound memory. */
export const AGENT_STATE_HISTORY_MAX = 20

export type AgentStatusEntry = {
  state: AgentStatusState
  /** The user's most recent prompt, when the hook payload carried one.
   *  Cached across the turn — subsequent tool-use events in the same turn do
   *  not include the prompt, so the renderer receives the last known value
   *  until a new prompt arrives or the pane resets. Empty when unknown. */
  prompt: string
  /** Timestamp (ms) of the last status update. */
  updatedAt: number
  agentType?: AgentType
  /** Composite key: `${tabId}:${paneId}` — matches the cacheTimerByKey convention. */
  paneKey: string
  terminalTitle?: string
  /** Rolling log of previous states. Each entry records a state the agent was in
   *  before transitioning to the current one. Capped at AGENT_STATE_HISTORY_MAX. */
  stateHistory: AgentStateHistoryEntry[]
  /** Name of the tool the agent is currently using (e.g. "Edit", "Bash"). */
  toolName?: string
  /** Short preview of the tool input (e.g. file path, command). */
  toolInput?: string
  /** Most recent assistant message preview, when the hook carried one. */
  lastAssistantMessage?: string
  /** True when the current `done` state was reached via an interrupt rather
   *  than a normal turn completion (Claude Code's `is_interrupt: true`).
   *  Orthogonal to `state`: the agent still finished the turn, but the user
   *  cancelled it. Undefined while the agent is working or for non-Claude
   *  agents that don't surface this signal. */
  interrupted?: boolean
}

// ─── Agent status payload shape (what hook receivers send via IPC) ──────────
// Hook integrations only need to provide normalized state fields. The
// remaining AgentStatusEntry fields (updatedAt, paneKey, etc.) are populated
// by the renderer when it receives the IPC event.

export type AgentStatusPayload = {
  state: AgentStatusState
  prompt?: string
  agentType?: AgentType
  toolName?: string
  toolInput?: string
  lastAssistantMessage?: string
  interrupted?: boolean
}

/**
 * The result of `parseAgentStatusPayload`: prompt is always normalized to a
 * string (empty string when the raw payload omits it), so consumers do not
 * need nullish-coalescing on the field. Tool/assistant fields stay optional so
 * absence ("no new info") is distinguishable from an explicit empty string.
 */
export type ParsedAgentStatusPayload = {
  state: AgentStatusState
  prompt: string
  agentType?: AgentType
  toolName?: string
  toolInput?: string
  lastAssistantMessage?: string
  interrupted?: boolean
}

/** Maximum character length for the prompt field. Truncated on parse. */
export const AGENT_STATUS_MAX_FIELD_LENGTH = 200
/** Maximum character length for the toolName field. */
export const AGENT_STATUS_TOOL_NAME_MAX_LENGTH = 60
/** Maximum character length for the toolInput preview. */
export const AGENT_STATUS_TOOL_INPUT_MAX_LENGTH = 160
/** Maximum character length for the lastAssistantMessage preview.
 *  Why: assistant messages are the user-facing "what did the agent say" body,
 *  expanded inline in the dashboard row. 8 KB comfortably fits a multi-
 *  paragraph summary while still providing a hard upper bound — the hook
 *  HTTP endpoint already caps bodies at 1 MB, but per-field truncation is a
 *  second line of defense against a buggy/malicious agent spamming huge
 *  strings into the cache (which lives per pane with bounded history). */
export const AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH = 8000
/**
 * Freshness threshold for explicit agent status. Retained past this point so
 * WorktreeCard's sidebar dot can decay "working" back to "active" when the
 * hook stream goes silent. Smart-sort + WorktreeCard still read this; the
 * dashboard + hover only display hook-reported data as-is.
 */
export const AGENT_STATUS_STALE_AFTER_MS = 30 * 60 * 1000

const VALID_STATES = new Set<AgentStatusState>(['working', 'blocked', 'waiting', 'done'])
/** Maximum length for the agent type label. */
const AGENT_TYPE_MAX_LENGTH = 40

/** Normalize a status field: trim, collapse to single line, truncate. */
function normalizeField(value: unknown, maxLength: number = AGENT_STATUS_MAX_FIELD_LENGTH): string {
  if (typeof value !== 'string') {
    return ''
  }
  const singleLine = value.trim().replace(/[\r\n]+/g, ' ')
  return singleLine.length > maxLength ? singleLine.slice(0, maxLength) : singleLine
}

// Why: assistant messages are a multi-paragraph "what did the agent say"
// body that the dashboard renders with `whitespace-pre-wrap`. Collapsing
// newlines here would erase structure the UI is designed to show. Still
// normalize `\r\n` → `\n` and cap paragraph gaps at one blank line to keep
// the bound meaningful, but otherwise preserve line breaks.
function normalizeMultilineField(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') {
    return ''
  }
  const normalized = value
    .trim()
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized
}

// Why: tool/assistant fields are optional on the entry (absence = "no update
// for this field"). We only surface them when the caller actually provided a
// string value so a missing field doesn't overwrite the prior cached state.
function normalizeOptionalField(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const normalized = normalizeField(value, maxLength)
  return normalized.length > 0 ? normalized : undefined
}

function normalizeOptionalMultilineField(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const normalized = normalizeMultilineField(value, maxLength)
  return normalized.length > 0 ? normalized : undefined
}

/**
 * Parse and validate an agent status JSON payload received from explicit
 * hook integrations or OSC 9999. Returns null if the payload is malformed or
 * has an invalid state.
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
      prompt: normalizeField(parsed.prompt),
      agentType:
        typeof parsed.agentType === 'string' && parsed.agentType.trim().length > 0
          ? parsed.agentType.trim().slice(0, AGENT_TYPE_MAX_LENGTH)
          : undefined,
      toolName: normalizeOptionalField(parsed.toolName, AGENT_STATUS_TOOL_NAME_MAX_LENGTH),
      toolInput: normalizeOptionalField(parsed.toolInput, AGENT_STATUS_TOOL_INPUT_MAX_LENGTH),
      lastAssistantMessage: normalizeOptionalMultilineField(
        parsed.lastAssistantMessage,
        AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH
      ),
      // Why: only meaningful on `done`. Coerce to undefined on other states so
      // the field doesn't leak stale truth through state transitions.
      interrupted: parsed.interrupted === true && state === 'done' ? true : undefined
    }
  } catch {
    return null
  }
}
