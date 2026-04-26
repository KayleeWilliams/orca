import type { PRComment } from '../../../../shared/types'

export type PRCommentAudienceFilter = 'all' | 'human' | 'bot'

const BOT_LOGIN_SUFFIX = '[bot]'
const AUTOMATION_LOGIN_PATTERNS = [
  /bot$/i,
  /-bot$/i,
  /\bbot\b/i,
  /automation/i,
  /actions/i,
  /renovate/i,
  /dependabot/i
]

export function isAutomatedPRComment(comment: PRComment): boolean {
  // Why: GitHub's REST `user.type === 'Bot'` and GraphQL `author.__typename === 'Bot'`
  // are authoritative and correctly flag third-party review bots (qodo-ai-reviewer,
  // coderabbitai, sonarcloud) whose logins don't contain "bot"/"automation".
  // Prefer that; fall back to the login heuristic only when the data source
  // can't report it (e.g. `gh pr view` non-GitHub fallback path).
  if (comment.isBot !== undefined) {
    return comment.isBot
  }
  const author = comment.author.trim()
  const normalized = author.toLowerCase()
  if (normalized.endsWith(BOT_LOGIN_SUFFIX)) {
    return true
  }
  return AUTOMATION_LOGIN_PATTERNS.some((pattern) => pattern.test(author))
}

export function filterPRCommentsByAudience(
  comments: PRComment[],
  filter: PRCommentAudienceFilter
): PRComment[] {
  if (filter === 'all') {
    return comments
  }
  return comments.filter((comment) => {
    const automated = isAutomatedPRComment(comment)
    return filter === 'bot' ? automated : !automated
  })
}
