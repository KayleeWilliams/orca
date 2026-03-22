// ─── Repo ────────────────────────────────────────────────────────────
export interface Repo {
  id: string
  path: string
  displayName: string
  badgeColor: string
  addedAt: number
  gitUsername?: string
  worktreeBaseRef?: string
  hookSettings?: RepoHookSettings
}

// ─── Worktree (git-level) ────────────────────────────────────────────
export interface GitWorktreeInfo {
  path: string
  head: string
  branch: string
  isBare: boolean
}

// ─── Worktree (app-level, enriched) ──────────────────────────────────
export interface Worktree extends GitWorktreeInfo {
  id: string // `${repoId}::${path}`
  repoId: string
  displayName: string
  comment: string
  linkedIssue: number | null
  linkedPR: number | null
  isArchived: boolean
  isUnread: boolean
  sortOrder: number
}

// ─── Worktree metadata (persisted user-authored fields only) ─────────
export interface WorktreeMeta {
  displayName: string
  comment: string
  linkedIssue: number | null
  linkedPR: number | null
  isArchived: boolean
  isUnread: boolean
  sortOrder: number
}

// ─── Terminal Tab ────────────────────────────────────────────────────
export interface TerminalTab {
  id: string
  ptyId: string | null
  worktreeId: string
  title: string
  customTitle: string | null
  color: string | null
  sortOrder: number
  createdAt: number
}

export type TerminalPaneSplitDirection = 'vertical' | 'horizontal'

export type TerminalPaneLayoutNode =
  | {
      type: 'leaf'
      leafId: string
    }
  | {
      type: 'split'
      direction: TerminalPaneSplitDirection
      first: TerminalPaneLayoutNode
      second: TerminalPaneLayoutNode
    }

export interface TerminalLayoutSnapshot {
  root: TerminalPaneLayoutNode | null
  activeLeafId: string | null
  expandedLeafId: string | null
}

export interface WorkspaceSessionState {
  activeRepoId: string | null
  activeWorktreeId: string | null
  activeTabId: string | null
  tabsByWorktree: Record<string, TerminalTab[]>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
}

// ─── GitHub ──────────────────────────────────────────────────────────
export type PRState = 'open' | 'closed' | 'merged' | 'draft'
export type IssueState = 'open' | 'closed'
export type CheckStatus = 'pending' | 'success' | 'failure' | 'neutral'

export interface PRInfo {
  number: number
  title: string
  state: PRState
  url: string
  checksStatus: CheckStatus
  updatedAt: string
}

export interface IssueInfo {
  number: number
  title: string
  state: IssueState
  url: string
  labels: string[]
}

// ─── Hooks (orca.yaml) ──────────────────────────────────────────────
export interface OrcaHooks {
  scripts: {
    setup?: string // Runs after worktree is created
    archive?: string // Runs before worktree is archived
  }
}

export interface RepoHookSettings {
  mode: 'auto' | 'override'
  scripts: {
    setup: string
    archive: string
  }
}

// ─── Updater ─────────────────────────────────────────────────────────
export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking'; userInitiated?: boolean }
  | { state: 'available'; version: string }
  | { state: 'not-available'; userInitiated?: boolean }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string; userInitiated?: boolean }

// ─── Settings ────────────────────────────────────────────────────────
export interface GlobalSettings {
  workspaceDir: string
  nestWorkspaces: boolean
  branchPrefix: 'git-username' | 'custom' | 'none'
  branchPrefixCustom: string
  theme: 'system' | 'dark' | 'light'
  terminalFontSize: number
  terminalFontFamily: string
  terminalCursorStyle: 'bar' | 'block' | 'underline'
  terminalCursorBlink: boolean
  terminalThemeDark: string
  terminalDividerColorDark: string
  terminalUseSeparateLightTheme: boolean
  terminalThemeLight: string
  terminalDividerColorLight: string
  terminalInactivePaneOpacity: number
  terminalActivePaneOpacity: number
  terminalPaneOpacityTransitionMs: number
  terminalDividerThicknessPx: number
  terminalScrollbackBytes: number
}

export interface PersistedUIState {
  lastActiveRepoId: string | null
  lastActiveWorktreeId: string | null
  sidebarWidth: number
  groupBy: 'none' | 'repo' | 'pr-status'
  sortBy: 'name' | 'recent' | 'repo'
  uiZoomLevel: number
}

// ─── Persistence shape ──────────────────────────────────────────────
export interface PersistedState {
  schemaVersion: number
  repos: Repo[]
  worktreeMeta: Record<string, WorktreeMeta>
  settings: GlobalSettings
  ui: PersistedUIState
  githubCache: {
    pr: Record<string, { data: PRInfo | null; fetchedAt: number }>
    issue: Record<string, { data: IssueInfo | null; fetchedAt: number }>
  }
  workspaceSession: WorkspaceSessionState
}
