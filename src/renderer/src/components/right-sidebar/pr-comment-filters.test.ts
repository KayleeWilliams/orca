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
