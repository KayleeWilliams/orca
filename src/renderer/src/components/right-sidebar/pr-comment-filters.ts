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
