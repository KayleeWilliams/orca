export type AgentStatus = 'working' | 'permission' | 'idle'

const GEMINI_WORKING = '\u2726' // ✦
const GEMINI_IDLE = '\u25C7' // ◇
const GEMINI_PERMISSION = '\u270B' // ✋

const AGENT_NAMES = ['claude', 'codex', 'gemini', 'opencode', 'aider']

function containsBrailleSpinner(title: string): boolean {
  for (const char of title) {
    const codePoint = char.codePointAt(0)
    if (codePoint !== undefined && codePoint >= 0x2800 && codePoint <= 0x28ff) {
      return true
    }
  }
  return false
}

function containsAgentName(title: string): boolean {
  const lower = title.toLowerCase()
  return AGENT_NAMES.some((name) => lower.includes(name))
}

function containsAny(title: string, words: string[]): boolean {
  const lower = title.toLowerCase()
  return words.some((word) => lower.includes(word))
}

const WORKING_KEYWORDS = ['working', 'thinking', 'running']

/**
 * Strip working-status indicators from a title so that
 * `detectAgentStatusFromTitle` will no longer return 'working'.
 * Used to clear stale titles when an agent exits without resetting its title.
 */
export function clearWorkingIndicators(title: string): string {
  let cleaned = title

  // Gemini working symbol
  cleaned = cleaned.replace(GEMINI_WORKING, '')

  // Braille spinner characters (U+2800–U+28FF)
  // eslint-disable-next-line no-control-regex -- intentional unicode range
  cleaned = cleaned.replace(/[\u2800-\u28FF]/g, '')

  // Claude Code ". " working prefix
  if (cleaned.startsWith('. ')) {
    cleaned = cleaned.slice(2)
  }

  // Strip working keywords that detectAgentStatusFromTitle would pick up
  // when the title also contains an agent name.
  if (containsAgentName(cleaned)) {
    for (const keyword of WORKING_KEYWORDS) {
      cleaned = cleaned.replace(new RegExp(`\\b${keyword}\\b`, 'gi'), '')
    }
  }

  // Collapse whitespace after removals
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim()

  return cleaned || title
}

export function detectAgentStatusFromTitle(title: string): AgentStatus | null {
  if (!title) {
    return null
  }

  // Gemini CLI symbols are the most specific and should take precedence.
  if (title.includes(GEMINI_PERMISSION)) {
    return 'permission'
  }
  if (title.includes(GEMINI_WORKING)) {
    return 'working'
  }
  if (title.includes(GEMINI_IDLE)) {
    return 'idle'
  }

  if (containsBrailleSpinner(title)) {
    return 'working'
  }

  if (containsAgentName(title)) {
    if (containsAny(title, ['action required', 'permission', 'waiting'])) {
      return 'permission'
    }
    if (containsAny(title, ['ready', 'idle', 'done'])) {
      return 'idle'
    }
    if (containsAny(title, ['working', 'thinking', 'running'])) {
      return 'working'
    }

    // Claude Code title prefixes: ". " = working, "* " = idle
    if (title.startsWith('. ')) {
      return 'working'
    }
    if (title.startsWith('* ')) {
      return 'idle'
    }

    return 'idle'
  }

  return null
}
