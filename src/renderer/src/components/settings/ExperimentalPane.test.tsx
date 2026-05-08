import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { ExperimentalPane } from './ExperimentalPane'
import { EXPERIMENTAL_SEARCH_ENTRY } from './experimental-search'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

describe('ExperimentalPane', () => {
  it('renders compact worktree cards as an off-by-default experimental switch', () => {
    const markup = renderToStaticMarkup(
      <ExperimentalPane settings={getDefaultSettings('/tmp')} updateSettings={vi.fn()} />
    )

    expect(markup).toContain('Compact worktree cards')
    expect(markup).toContain('aria-checked="false"')
    expect(markup).toContain('Collapses a card only when its second line would be empty or repeat')
    expect(markup).toContain('different branch')
    expect(EXPERIMENTAL_SEARCH_ENTRY.compactWorktreeCards.keywords).toContain('metadata')
  })

  it('renders branch name suggestions as an off-by-default experimental switch', () => {
    const markup = renderToStaticMarkup(
      <ExperimentalPane settings={getDefaultSettings('/tmp')} updateSettings={vi.fn()} />
    )

    expect(markup).toContain('Branch name suggestions')
    expect(markup).toContain('newly created local Orca branch')
    expect(markup).toContain('Supported agents')
    expect(EXPERIMENTAL_SEARCH_ENTRY.branchNames.keywords).toContain('opencode')
  })
})
