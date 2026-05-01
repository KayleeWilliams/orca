import { describe, expect, it } from 'vitest'
import { collectBrowserWebviewIds } from './browser-webview-cleanup'
import type { BrowserPage, BrowserWorkspace } from '../../../../shared/types'

function workspace(id: string): BrowserWorkspace {
  return {
    id,
    worktreeId: 'wt-1',
    label: id,
    sessionProfileId: null,
    pageIds: [],
    activePageId: null,
    url: 'about:blank',
    title: id,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
}

function page(id: string, workspaceId: string): BrowserPage {
  return {
    id,
    workspaceId,
    worktreeId: 'wt-1',
    url: 'about:blank',
    title: id,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
}

describe('collectBrowserWebviewIds', () => {
  it('tracks browser page ids because webviews are keyed by page id', () => {
    const ids = collectBrowserWebviewIds(
      { 'wt-1': [workspace('workspace-1')] },
      { 'workspace-1': [page('page-1', 'workspace-1'), page('page-2', 'workspace-1')] }
    )

    expect([...ids].sort()).toEqual(['page-1', 'page-2'])
  })

  it('keeps legacy workspace ids only when no page records exist', () => {
    const ids = collectBrowserWebviewIds({ 'wt-1': [workspace('legacy-workspace')] }, {})

    expect([...ids]).toEqual(['legacy-workspace'])
  })
})
