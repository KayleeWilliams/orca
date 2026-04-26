import { describe, expect, it } from 'vitest'
import type { PRComment } from '../../../../shared/types'
import { filterPRCommentsByAudience, isAutomatedPRComment } from './pr-comment-filters'

function comment(author: string): PRComment {
  return {
    id: author.length,
    author,
    authorAvatarUrl: '',
    body: 'body',
    createdAt: '2026-04-26T00:00:00.000Z',
    url: ''
  }
}

describe('pr-comment-filters', () => {
  it('classifies GitHub app and automation authors as bot comments', () => {
    expect(isAutomatedPRComment(comment('github-actions[bot]'))).toBe(true)
    expect(isAutomatedPRComment(comment('dependabot[bot]'))).toBe(true)
    expect(isAutomatedPRComment(comment('renovate-bot'))).toBe(true)
    expect(isAutomatedPRComment(comment('preview-automation'))).toBe(true)
  })

  it('keeps normal user logins as human comments', () => {
    expect(isAutomatedPRComment(comment('octocat'))).toBe(false)
    expect(isAutomatedPRComment(comment('robotics-dev'))).toBe(false)
  })

  it('trusts the GitHub-provided isBot flag over the login heuristic', () => {
    // Third-party review bots like qodo-ai-reviewer don't contain "bot" in
    // their login, so the heuristic alone misclassifies them. GitHub's
    // user.type / __typename signal is authoritative.
    expect(isAutomatedPRComment({ ...comment('qodo-ai-reviewer'), isBot: true })).toBe(true)
    expect(isAutomatedPRComment({ ...comment('coderabbitai'), isBot: true })).toBe(true)
    // Explicit isBot=false wins over a suspicious-looking login.
    expect(isAutomatedPRComment({ ...comment('robotics-dev'), isBot: false })).toBe(false)
  })

  it('filters comments by audience', () => {
    const comments = [
      comment('octocat'),
      comment('github-actions[bot]'),
      comment('mona'),
      comment('dependabot[bot]')
    ]

    expect(filterPRCommentsByAudience(comments, 'all')).toEqual(comments)
    expect(filterPRCommentsByAudience(comments, 'human').map((c) => c.author)).toEqual([
      'octocat',
      'mona'
    ])
    expect(filterPRCommentsByAudience(comments, 'bot').map((c) => c.author)).toEqual([
      'github-actions[bot]',
      'dependabot[bot]'
    ])
  })
})
