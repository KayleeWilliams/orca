/* eslint-disable max-lines -- Why: the new-workspace flow intentionally keeps the
composer, task picker, and create-side effects co-located so the draft sidebar
state and launch logic stay in one place while this surface is still evolving. */
import React, { startTransition, useEffect, useCallback, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  CircleDot,
  EllipsisVertical,
  ExternalLink,
  Github,
  GitPullRequest,
  LoaderCircle,
  RefreshCw,
  Search,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import RepoCombobox from '@/components/repo/RepoCombobox'
import NewWorkspaceComposerCard from '@/components/NewWorkspaceComposerCard'
import { cn } from '@/lib/utils'
import { LightRays } from '@/components/ui/light-rays'
import { parseGitHubIssueOrPRNumber } from '@/lib/github-links'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import {
  buildAgentStartupPlan,
  isShellProcess,
  type AgentStartupPlan
} from '@/lib/tui-agent-startup'
import { isGitRepoKind } from '../../../shared/repo-kind'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import type {
  GitHubWorkItem,
  OrcaHooks,
  SetupDecision,
  SetupRunPolicy,
  TuiAgent,
  TaskViewPresetId
} from '../../../shared/types'

type TaskSource = 'github' | 'linear'
type TaskQueryPreset = {
  id: TaskViewPresetId
  label: string
  query: string
}

type SourceOption = {
  id: TaskSource
  label: string
  Icon: (props: { className?: string }) => React.JSX.Element
  disabled?: boolean
}

function LinearIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
    </svg>
  )
}

const SOURCE_OPTIONS: SourceOption[] = [
  {
    id: 'github',
    label: 'GitHub',
    Icon: ({ className }) => <Github className={className} />
  },
  {
    id: 'linear',
    label: 'Linear',
    Icon: ({ className }) => <LinearIcon className={className} />
  }
]

const TASK_QUERY_PRESETS: TaskQueryPreset[] = [
  { id: 'all', label: 'All', query: 'is:open' },
  { id: 'issues', label: 'Issues', query: 'is:open' },
  { id: 'my-issues', label: 'My Issues', query: 'assignee:@me is:open' },
  {
    id: 'review',
    label: 'Needs My Review',
    query: 'review-requested:@me is:open'
  },
  { id: 'prs', label: 'PRs', query: 'is:open' },
  { id: 'my-prs', label: 'My PRs', query: 'author:@me is:open' }
]

function getTaskPresetQuery(presetId: TaskViewPresetId | null): string {
  if (!presetId) {
    return 'is:open'
  }
  return TASK_QUERY_PRESETS.find((preset) => preset.id === presetId)?.query ?? 'is:open'
}

const TASK_SEARCH_DEBOUNCE_MS = 300
const isMac = navigator.userAgent.includes('Mac')
const ADD_ATTACHMENT_SHORTCUT = isMac ? '⌘U' : 'Ctrl+U'
const CLIENT_PLATFORM: NodeJS.Platform = navigator.userAgent.includes('Windows')
  ? 'win32'
  : navigator.userAgent.includes('Mac')
    ? 'darwin'
    : 'linux'

type RepoSlug = {
  owner: string
  repo: string
}

type GitHubLinkQuery = {
  query: string
  repoMismatch: string | null
  directNumber: number | null
}

function buildAgentPromptWithContext(
  prompt: string,
  attachments: string[],
  linkedUrls: string[]
): string {
  const trimmedPrompt = prompt.trim()
  if (attachments.length === 0 && linkedUrls.length === 0) {
    return trimmedPrompt
  }

  const sections: string[] = []
  if (attachments.length > 0) {
    const attachmentBlock = attachments.map((pathValue) => `- ${pathValue}`).join('\n')
    sections.push(`Attachments:\n${attachmentBlock}`)
  }
  if (linkedUrls.length > 0) {
    const linkBlock = linkedUrls.map((url) => `- ${url}`).join('\n')
    sections.push(`Linked work items:\n${linkBlock}`)
  }
  // Why: the new-workspace flow launches each agent with a single plain-text
  // startup prompt. Appending attachments and linked URLs keeps extra context
  // visible to Claude/Codex/OpenCode without cluttering the visible textarea.
  if (!trimmedPrompt) {
    return sections.join('\n\n')
  }
  return `${trimmedPrompt}\n\n${sections.join('\n\n')}`
}

function getAttachmentLabel(pathValue: string): string {
  const segments = pathValue.split(/[/\\]/)
  return segments.at(-1) || pathValue
}

function normalizeGitHubLinkQuery(raw: string, repoSlug: RepoSlug | null): GitHubLinkQuery {
  const trimmed = raw.trim()
  if (!trimmed) {
    return { query: '', repoMismatch: null, directNumber: null }
  }

  const direct = parseGitHubIssueOrPRNumber(trimmed)
  if (direct !== null && !trimmed.startsWith('http')) {
    return { query: trimmed, repoMismatch: null, directNumber: direct }
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(trimmed)
  } catch {
    return { query: trimmed, repoMismatch: null, directNumber: null }
  }

  if (!/^(?:www\.)?github\.com$/i.test(parsedUrl.hostname)) {
    return { query: trimmed, repoMismatch: null, directNumber: null }
  }

  const match = parsedUrl.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)(?:\/)?$/i)
  if (!match) {
    return { query: trimmed, repoMismatch: null, directNumber: null }
  }

  if (
    repoSlug &&
    (match[1].toLowerCase() !== repoSlug.owner.toLowerCase() ||
      match[2].toLowerCase() !== repoSlug.repo.toLowerCase())
  ) {
    return {
      query: '',
      repoMismatch: `${repoSlug.owner}/${repoSlug.repo}`,
      directNumber: null
    }
  }

  return {
    query: trimmed,
    repoMismatch: null,
    directNumber: Number.parseInt(match[3], 10)
  }
}

function getWorkItemSearchText(item: GitHubWorkItem): string {
  return [
    item.type,
    item.number,
    item.title,
    item.author ?? '',
    item.labels.join(' '),
    item.branchName ?? '',
    item.baseRefName ?? ''
  ]
    .join(' ')
    .toLowerCase()
}

async function ensureAgentStartupInTerminal(args: {
  worktreeId: string
  startup: AgentStartupPlan
}): Promise<void> {
  const { worktreeId, startup } = args
  if (startup.followupPrompt === null) {
    return
  }

  let promptInjected = false

  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, 150))
    }

    const state = useAppStore.getState()
    const tabId =
      state.activeTabIdByWorktree[worktreeId] ?? state.tabsByWorktree[worktreeId]?.[0]?.id ?? null
    if (!tabId) {
      continue
    }

    const ptyId = state.ptyIdsByTabId[tabId]?.[0]
    if (!ptyId) {
      continue
    }

    try {
      const foreground = (await window.api.pty.getForegroundProcess(ptyId))?.toLowerCase() ?? ''
      const agentOwnsForeground =
        foreground === startup.expectedProcess ||
        foreground.startsWith(`${startup.expectedProcess}.`)

      if (agentOwnsForeground && !promptInjected && startup.followupPrompt) {
        window.api.pty.write(ptyId, `${startup.followupPrompt}\r`)
        promptInjected = true
        return
      }

      if (agentOwnsForeground && promptInjected) {
        return
      }

      const hasChildProcesses = await window.api.pty.hasChildProcesses(ptyId)
      if (
        !promptInjected &&
        startup.followupPrompt &&
        hasChildProcesses &&
        !isShellProcess(foreground) &&
        attempt >= 4
      ) {
        // Why: the initial agent launch is already queued on the first terminal
        // tab. Only agents without a verified startup-prompt flag need extra
        // help here: once the TUI owns the PTY, type the draft prompt into the
        // live session instead of launching the binary a second time.
        window.api.pty.write(ptyId, `${startup.followupPrompt}\r`)
        promptInjected = true
        return
      }
    } catch {
      // Ignore transient PTY inspection failures and keep polling.
    }
  }
}

function formatRelativeTime(input: string): string {
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) {
    return 'recently'
  }

  const diffMs = date.getTime() - Date.now()
  const diffMinutes = Math.round(diffMs / 60_000)
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

  if (Math.abs(diffMinutes) < 60) {
    return formatter.format(diffMinutes, 'minute')
  }

  const diffHours = Math.round(diffMinutes / 60)
  if (Math.abs(diffHours) < 24) {
    return formatter.format(diffHours, 'hour')
  }

  const diffDays = Math.round(diffHours / 24)
  return formatter.format(diffDays, 'day')
}

function getSetupConfig(
  repo: { hookSettings?: { scripts?: { setup?: string } } } | undefined,
  yamlHooks: OrcaHooks | null
): { source: 'yaml' | 'legacy'; command: string } | null {
  const yamlSetup = yamlHooks?.scripts?.setup?.trim()
  if (yamlSetup) {
    return { source: 'yaml', command: yamlSetup }
  }
  const legacySetup = repo?.hookSettings?.scripts?.setup?.trim()
  if (legacySetup) {
    return { source: 'legacy', command: legacySetup }
  }
  return null
}

function getTaskStatusLabel(item: GitHubWorkItem): string {
  if (item.type === 'issue') {
    return 'Open'
  }
  if (item.state === 'draft') {
    return 'Draft'
  }
  return 'Ready'
}

function getTaskStatusTone(item: GitHubWorkItem): string {
  if (item.type === 'issue') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
  }
  if (item.state === 'draft') {
    return 'border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300'
  }
  return 'border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-200'
}

function getLinkedWorkItemSuggestedName(item: GitHubWorkItem): string {
  const withoutLeadingNumber = item.title
    .trim()
    .replace(/^(?:issue|pr|pull request)\s*#?\d+\s*[:-]\s*/i, '')
    .replace(/^#\d+\s*[:-]\s*/, '')
    .replace(/\(#\d+\)/gi, '')
    .replace(/\b#\d+\b/g, '')
    .trim()
  const seed = withoutLeadingNumber || item.title.trim()
  return seed
    .toLowerCase()
    .replace(/[\\/]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 48)
    .replace(/[-._]+$/g, '')
}

function getWorkspaceSeedName(args: {
  explicitName: string
  prompt: string
  linkedIssueNumber: number | null
  linkedPR: number | null
}): string {
  const { explicitName, prompt, linkedIssueNumber, linkedPR } = args
  if (explicitName.trim()) {
    return explicitName.trim()
  }
  if (linkedPR !== null) {
    return `pr-${linkedPR}`
  }
  if (linkedIssueNumber !== null) {
    return `issue-${linkedIssueNumber}`
  }
  if (prompt.trim()) {
    return prompt.trim()
  }
  // Why: the prompt is optional in this flow. Fall back to a stable default
  // branch/workspace seed so users can launch an empty draft without first
  // writing a brief or naming the workspace manually.
  return 'workspace'
}

export default function NewWorkspacePage(): React.JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const settings = useAppStore((s) => s.settings)
  const pageData = useAppStore((s) => s.newWorkspacePageData)
  const newWorkspaceDraft = useAppStore((s) => s.newWorkspaceDraft)
  const closeNewWorkspacePage = useAppStore((s) => s.closeNewWorkspacePage)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const setNewWorkspaceDraft = useAppStore((s) => s.setNewWorkspaceDraft)
  const clearNewWorkspaceDraft = useAppStore((s) => s.clearNewWorkspaceDraft)
  const createWorktree = useAppStore((s) => s.createWorktree)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen)
  const setRightSidebarOpen = useAppStore((s) => s.setRightSidebarOpen)
  const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab)

  const eligibleRepos = useMemo(() => repos.filter((repo) => isGitRepoKind(repo)), [repos])
  const initialRepoId =
    newWorkspaceDraft?.repoId && eligibleRepos.some((repo) => repo.id === newWorkspaceDraft.repoId)
      ? newWorkspaceDraft.repoId
      : pageData.preselectedRepoId &&
          eligibleRepos.some((repo) => repo.id === pageData.preselectedRepoId)
        ? pageData.preselectedRepoId
        : activeRepoId && eligibleRepos.some((repo) => repo.id === activeRepoId)
          ? activeRepoId
          : (eligibleRepos[0]?.id ?? '')

  const [repoId, setRepoId] = useState(initialRepoId)
  const [name, setName] = useState(newWorkspaceDraft?.name ?? pageData.prefilledName ?? '')
  const [linkedIssue, setLinkedIssue] = useState(newWorkspaceDraft?.linkedIssue ?? '')
  const [linkedPR, setLinkedPR] = useState<number | null>(newWorkspaceDraft?.linkedPR ?? null)
  const [linkedWorkItem, setLinkedWorkItem] = useState(newWorkspaceDraft?.linkedWorkItem ?? null)
  const [agentPrompt, setAgentPrompt] = useState(newWorkspaceDraft?.prompt ?? '')
  const [note, setNote] = useState(newWorkspaceDraft?.note ?? '')
  const [attachmentPaths, setAttachmentPaths] = useState<string[]>(
    newWorkspaceDraft?.attachments ?? []
  )
  const [tuiAgent, setTuiAgent] = useState<TuiAgent>(
    newWorkspaceDraft?.agent ?? settings?.defaultTuiAgent ?? 'claude'
  )
  const [detectedAgentIds, setDetectedAgentIds] = useState<Set<string> | null>(null)
  const [yamlHooks, setYamlHooks] = useState<OrcaHooks | null>(null)
  const [checkedHooksRepoId, setCheckedHooksRepoId] = useState<string | null>(null)
  const [setupDecision, setSetupDecision] = useState<'run' | 'skip' | null>(null)
  const [runIssueAutomation, setRunIssueAutomation] = useState(false)
  const [issueCommandTemplate, setIssueCommandTemplate] = useState('')
  const [hasLoadedIssueCommand, setHasLoadedIssueCommand] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [modalName, setModalName] = useState('')
  const [modalLinkedIssue, setModalLinkedIssue] = useState('')
  const [modalLinkedPR, setModalLinkedPR] = useState<number | null>(null)
  const [modalLinkedWorkItem, setModalLinkedWorkItem] = useState<{
    type: 'issue' | 'pr'
    number: number
    title: string
    url: string
  } | null>(null)
  const [modalAgentPrompt, setModalAgentPrompt] = useState('')
  const [modalNote, setModalNote] = useState('')
  const [modalAttachmentPaths, setModalAttachmentPaths] = useState<string[]>([])
  const [modalTuiAgent, setModalTuiAgent] = useState<TuiAgent>(
    newWorkspaceDraft?.agent ?? settings?.defaultTuiAgent ?? 'claude'
  )
  const [modalSetupDecision, setModalSetupDecision] = useState<'run' | 'skip' | null>(null)
  const [modalCreating, setModalCreating] = useState(false)
  const [modalCreateError, setModalCreateError] = useState<string | null>(null)
  const [taskSource, setTaskSource] = useState<TaskSource>('github')
  const [taskSearchInput, setTaskSearchInput] = useState('')
  const [appliedTaskSearch, setAppliedTaskSearch] = useState('')
  const [activeTaskPreset, setActiveTaskPreset] = useState<TaskViewPresetId | null>('all')
  const [tasksLoading, setTasksLoading] = useState(false)
  const [tasksError, setTasksError] = useState<string | null>(null)
  const [taskRefreshNonce, setTaskRefreshNonce] = useState(0)
  const [workItems, setWorkItems] = useState<GitHubWorkItem[]>([])
  const [linkPopoverOpen, setLinkPopoverOpen] = useState(false)
  const [linkQuery, setLinkQuery] = useState('')
  const [linkRepoSlug, setLinkRepoSlug] = useState<RepoSlug | null>(null)
  const [linkItems, setLinkItems] = useState<GitHubWorkItem[]>([])
  const [linkItemsLoading, setLinkItemsLoading] = useState(false)
  const [linkDirectItem, setLinkDirectItem] = useState<GitHubWorkItem | null>(null)
  const [linkDirectLoading, setLinkDirectLoading] = useState(false)
  const [linkDebouncedQuery, setLinkDebouncedQuery] = useState('')
  const [modalLinkPopoverOpen, setModalLinkPopoverOpen] = useState(false)
  const [modalLinkQuery, setModalLinkQuery] = useState('')
  const [modalLinkDirectItem, setModalLinkDirectItem] = useState<GitHubWorkItem | null>(null)
  const [modalLinkDirectLoading, setModalLinkDirectLoading] = useState(false)
  const [modalLinkDebouncedQuery, setModalLinkDebouncedQuery] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(Boolean((newWorkspaceDraft?.note ?? '').trim()))
  const [modalAdvancedOpen, setModalAdvancedOpen] = useState(false)
  const [composerModalOpen, setComposerModalOpen] = useState(false)
  const lastAutoNameRef = useRef(newWorkspaceDraft?.name ?? pageData.prefilledName ?? '')
  const modalLastAutoNameRef = useRef('')
  const nameInputRef = useRef<HTMLInputElement>(null)
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  const modalNameInputRef = useRef<HTMLInputElement>(null)
  const modalPromptTextareaRef = useRef<HTMLTextAreaElement>(null)
  const modalComposerRef = useRef<HTMLDivElement>(null)

  const selectedRepo = eligibleRepos.find((repo) => repo.id === repoId)
  const parsedLinkedIssueNumber = useMemo(
    () => (linkedIssue.trim() ? parseGitHubIssueOrPRNumber(linkedIssue) : null),
    [linkedIssue]
  )
  const parsedModalLinkedIssueNumber = useMemo(
    () => (modalLinkedIssue.trim() ? parseGitHubIssueOrPRNumber(modalLinkedIssue) : null),
    [modalLinkedIssue]
  )
  const defaultTaskViewPreset = settings?.defaultTaskViewPreset ?? 'all'
  const setupConfig = useMemo(
    () => getSetupConfig(selectedRepo, yamlHooks),
    [selectedRepo, yamlHooks]
  )
  const setupPolicy: SetupRunPolicy = selectedRepo?.hookSettings?.setupRunPolicy ?? 'run-by-default'
  const hasIssueAutomationConfig = issueCommandTemplate.length > 0
  const canOfferIssueAutomation = parsedLinkedIssueNumber !== null && hasIssueAutomationConfig
  const shouldRunIssueAutomation = canOfferIssueAutomation && runIssueAutomation
  const shouldWaitForIssueAutomationCheck =
    parsedLinkedIssueNumber !== null && !hasLoadedIssueCommand
  const requiresExplicitSetupChoice = Boolean(setupConfig) && setupPolicy === 'ask'
  const resolvedSetupDecision =
    setupDecision ??
    (!setupConfig || setupPolicy === 'ask'
      ? null
      : setupPolicy === 'run-by-default'
        ? 'run'
        : 'skip')
  const resolvedModalSetupDecision =
    modalSetupDecision ??
    (!setupConfig || setupPolicy === 'ask'
      ? null
      : setupPolicy === 'run-by-default'
        ? 'run'
        : 'skip')
  const isSetupCheckPending = Boolean(repoId) && checkedHooksRepoId !== repoId
  const shouldWaitForSetupCheck = Boolean(selectedRepo) && isSetupCheckPending

  const filteredWorkItems = useMemo(() => {
    if (!activeTaskPreset) {
      return workItems
    }

    return workItems.filter((item) => {
      if (activeTaskPreset === 'issues') {
        return item.type === 'issue'
      }
      if (activeTaskPreset === 'review') {
        return item.type === 'pr'
      }
      if (activeTaskPreset === 'my-issues') {
        return item.type === 'issue'
      }
      if (activeTaskPreset === 'prs') {
        return item.type === 'pr'
      }
      if (activeTaskPreset === 'my-prs') {
        return item.type === 'pr'
      }
      return true
    })
  }, [activeTaskPreset, workItems])

  const workspaceSeedName = useMemo(
    () =>
      getWorkspaceSeedName({
        explicitName: name,
        prompt: agentPrompt,
        linkedIssueNumber: parsedLinkedIssueNumber,
        linkedPR
      }),
    [agentPrompt, linkedPR, name, parsedLinkedIssueNumber]
  )
  const modalWorkspaceSeedName = useMemo(
    () =>
      getWorkspaceSeedName({
        explicitName: modalName,
        prompt: modalAgentPrompt,
        linkedIssueNumber: parsedModalLinkedIssueNumber,
        linkedPR: modalLinkedPR
      }),
    [modalAgentPrompt, modalLinkedPR, modalName, parsedModalLinkedIssueNumber]
  )
  const startupPrompt = useMemo(
    () =>
      buildAgentPromptWithContext(
        agentPrompt,
        attachmentPaths,
        linkedWorkItem?.url ? [linkedWorkItem.url] : []
      ),
    [agentPrompt, attachmentPaths, linkedWorkItem?.url]
  )
  const modalStartupPrompt = useMemo(
    () =>
      buildAgentPromptWithContext(
        modalAgentPrompt,
        modalAttachmentPaths,
        modalLinkedWorkItem?.url ? [modalLinkedWorkItem.url] : []
      ),
    [modalAgentPrompt, modalAttachmentPaths, modalLinkedWorkItem?.url]
  )
  const normalizedLinkQuery = useMemo(
    () => normalizeGitHubLinkQuery(linkDebouncedQuery, linkRepoSlug),
    [linkDebouncedQuery, linkRepoSlug]
  )
  const normalizedModalLinkQuery = useMemo(
    () => normalizeGitHubLinkQuery(modalLinkDebouncedQuery, linkRepoSlug),
    [modalLinkDebouncedQuery, linkRepoSlug]
  )
  const filteredLinkItems = useMemo(() => {
    if (normalizedLinkQuery.directNumber !== null) {
      return linkDirectItem ? [linkDirectItem] : []
    }

    const query = normalizedLinkQuery.query.trim().toLowerCase()
    if (!query) {
      return linkItems
    }

    return linkItems.filter((item) => getWorkItemSearchText(item).includes(query))
  }, [linkDirectItem, linkItems, normalizedLinkQuery.directNumber, normalizedLinkQuery.query])
  const filteredModalLinkItems = useMemo(() => {
    if (normalizedModalLinkQuery.directNumber !== null) {
      return modalLinkDirectItem ? [modalLinkDirectItem] : []
    }

    const query = normalizedModalLinkQuery.query.trim().toLowerCase()
    if (!query) {
      return linkItems
    }

    return linkItems.filter((item) => getWorkItemSearchText(item).includes(query))
  }, [
    linkItems,
    modalLinkDirectItem,
    normalizedModalLinkQuery.directNumber,
    normalizedModalLinkQuery.query
  ])
  useEffect(() => {
    setNewWorkspaceDraft({
      repoId: repoId || null,
      name,
      prompt: agentPrompt,
      note,
      attachments: attachmentPaths,
      linkedWorkItem,
      agent: tuiAgent,
      linkedIssue,
      linkedPR
    })
  }, [
    agentPrompt,
    attachmentPaths,
    linkedIssue,
    linkedPR,
    linkedWorkItem,
    note,
    name,
    repoId,
    setNewWorkspaceDraft,
    tuiAgent
  ])

  useEffect(() => {
    if (!repoId && eligibleRepos[0]?.id) {
      setRepoId(eligibleRepos[0].id)
    }
  }, [eligibleRepos, repoId])

  useEffect(() => {
    const timeout = window.setTimeout(() => setLinkDebouncedQuery(linkQuery), 250)
    return () => window.clearTimeout(timeout)
  }, [linkQuery])

  useEffect(() => {
    const timeout = window.setTimeout(() => setModalLinkDebouncedQuery(modalLinkQuery), 250)
    return () => window.clearTimeout(timeout)
  }, [modalLinkQuery])

  useEffect(() => {
    if (composerModalOpen) {
      modalPromptTextareaRef.current?.focus()
      return
    }
    promptTextareaRef.current?.focus()
  }, [composerModalOpen])

  // Why: detect which agents are installed once on mount so the dropdown can
  // surface installed agents first. If settings.defaultTuiAgent is null (auto),
  // also update the selection to the first detected agent so the pre-selection
  // reflects the user's actual environment without requiring manual configuration.
  useEffect(() => {
    void window.api.preflight.detectAgents().then((ids) => {
      setDetectedAgentIds(new Set(ids))
      if (!newWorkspaceDraft?.agent && !settings?.defaultTuiAgent && ids.length > 0) {
        const firstInCatalogOrder = AGENT_CATALOG.find((a) => ids.includes(a.id))
        if (firstInCatalogOrder) {
          setTuiAgent(firstInCatalogOrder.id)
        }
      }
    })
    // Why: intentionally run only once on mount — detection is a best-effort
    // PATH snapshot and does not need to re-run when the draft or settings change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!repoId) {
      return
    }

    let cancelled = false
    setHasLoadedIssueCommand(false)
    setIssueCommandTemplate('')
    setYamlHooks(null)
    setCheckedHooksRepoId(null)

    void window.api.hooks
      .check({ repoId })
      .then((result) => {
        if (!cancelled) {
          setYamlHooks(result.hooks)
          setCheckedHooksRepoId(repoId)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setYamlHooks(null)
          setCheckedHooksRepoId(repoId)
        }
      })

    void window.api.hooks
      .readIssueCommand({ repoId })
      .then((result) => {
        if (!cancelled) {
          setIssueCommandTemplate(result.effectiveContent ?? '')
          setHasLoadedIssueCommand(true)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setIssueCommandTemplate('')
          setHasLoadedIssueCommand(true)
        }
      })

    return () => {
      cancelled = true
    }
  }, [repoId])

  useEffect(() => {
    if (!selectedRepo) {
      setLinkRepoSlug(null)
      return
    }

    let cancelled = false
    void window.api.gh
      .repoSlug({ repoPath: selectedRepo.path })
      .then((slug) => {
        if (!cancelled) {
          setLinkRepoSlug(slug)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLinkRepoSlug(null)
        }
      })

    return () => {
      cancelled = true
    }
  }, [selectedRepo])

  useEffect(() => {
    if (shouldWaitForSetupCheck) {
      setSetupDecision(null)
      return
    }
    if (!setupConfig) {
      setSetupDecision(null)
      return
    }
    if (setupPolicy === 'ask') {
      setSetupDecision(null)
      return
    }
    setSetupDecision(setupPolicy === 'run-by-default' ? 'run' : 'skip')
  }, [setupConfig, setupPolicy, shouldWaitForSetupCheck])

  useEffect(() => {
    if (shouldWaitForSetupCheck) {
      setModalSetupDecision(null)
      return
    }
    if (!setupConfig) {
      setModalSetupDecision(null)
      return
    }
    if (setupPolicy === 'ask') {
      setModalSetupDecision(null)
      return
    }
    setModalSetupDecision(setupPolicy === 'run-by-default' ? 'run' : 'skip')
  }, [setupConfig, setupPolicy, shouldWaitForSetupCheck])

  useEffect(() => {
    if (!canOfferIssueAutomation) {
      setRunIssueAutomation(false)
      return
    }
    setRunIssueAutomation(true)
  }, [canOfferIssueAutomation])

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setAppliedTaskSearch(taskSearchInput)
    }, TASK_SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timeout)
  }, [taskSearchInput])

  useEffect(() => {
    if (taskSource !== 'github' || !selectedRepo) {
      return
    }

    let cancelled = false
    setTasksLoading(true)
    setTasksError(null)

    // Why: the buttons below populate the same search bar the user can edit by
    // hand, so the fetch path has to honor both the preset GitHub query and any
    // ad-hoc qualifiers the user types (for example assignee:@me). The fetch is
    // debounced through `appliedTaskSearch` so backspacing all the way to empty
    // refires the query without spamming GitHub on every keystroke.
    void window.api.gh
      .listWorkItems({
        repoPath: selectedRepo.path,
        limit: 36,
        query: appliedTaskSearch.trim() || undefined
      })
      .then((items) => {
        if (!cancelled) {
          setWorkItems(items)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setTasksError(error instanceof Error ? error.message : 'Failed to load GitHub work.')
          setWorkItems([])
        }
      })
      .finally(() => {
        if (!cancelled) {
          setTasksLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [appliedTaskSearch, selectedRepo, taskRefreshNonce, taskSource])

  useEffect(() => {
    if (!linkPopoverOpen || !selectedRepo) {
      return
    }

    let cancelled = false
    setLinkItemsLoading(true)

    void window.api.gh
      .listWorkItems({ repoPath: selectedRepo.path, limit: 100 })
      .then((items) => {
        if (!cancelled) {
          setLinkItems(items)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLinkItems([])
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLinkItemsLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [linkPopoverOpen, selectedRepo])

  useEffect(() => {
    if (!modalLinkPopoverOpen || !selectedRepo) {
      return
    }

    let cancelled = false
    setLinkItemsLoading(true)

    void window.api.gh
      .listWorkItems({ repoPath: selectedRepo.path, limit: 100 })
      .then((items) => {
        if (!cancelled) {
          setLinkItems(items)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLinkItems([])
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLinkItemsLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [modalLinkPopoverOpen, selectedRepo])

  useEffect(() => {
    if (!linkPopoverOpen || !selectedRepo || normalizedLinkQuery.directNumber === null) {
      setLinkDirectItem(null)
      setLinkDirectLoading(false)
      return
    }

    let cancelled = false
    setLinkDirectLoading(true)
    // Why: Superset lets users paste a full GitHub URL or type a raw issue/PR
    // number and still get a concrete selectable result. Orca mirrors that by
    // resolving direct lookups against the selected repo instead of requiring a
    // text match in the recent-items list.
    void window.api.gh
      .workItem({ repoPath: selectedRepo.path, number: normalizedLinkQuery.directNumber })
      .then((item) => {
        if (!cancelled) {
          setLinkDirectItem(item)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLinkDirectItem(null)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLinkDirectLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [linkPopoverOpen, normalizedLinkQuery.directNumber, selectedRepo])

  useEffect(() => {
    if (!modalLinkPopoverOpen || !selectedRepo || normalizedModalLinkQuery.directNumber === null) {
      setModalLinkDirectItem(null)
      setModalLinkDirectLoading(false)
      return
    }

    let cancelled = false
    setModalLinkDirectLoading(true)
    void window.api.gh
      .workItem({ repoPath: selectedRepo.path, number: normalizedModalLinkQuery.directNumber })
      .then((item) => {
        if (!cancelled) {
          setModalLinkDirectItem(item)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setModalLinkDirectItem(null)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setModalLinkDirectLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [modalLinkPopoverOpen, normalizedModalLinkQuery.directNumber, selectedRepo])

  const applyLinkedWorkItem = useCallback(
    (item: GitHubWorkItem): void => {
      if (item.type === 'issue') {
        setLinkedIssue(String(item.number))
        setLinkedPR(null)
      } else {
        setLinkedIssue('')
        setLinkedPR(item.number)
      }
      setLinkedWorkItem({
        type: item.type,
        number: item.number,
        title: item.title,
        url: item.url
      })
      const suggestedName = getLinkedWorkItemSuggestedName(item)
      if (suggestedName && (!name.trim() || name === lastAutoNameRef.current)) {
        setName(suggestedName)
        lastAutoNameRef.current = suggestedName
      }
    },
    [name]
  )

  const handleSelectWorkItem = (item: GitHubWorkItem): void => {
    if (item.type === 'issue') {
      setModalLinkedIssue(String(item.number))
      setModalLinkedPR(null)
    } else {
      setModalLinkedIssue('')
      setModalLinkedPR(item.number)
    }
    setModalLinkedWorkItem({
      type: item.type,
      number: item.number,
      title: item.title,
      url: item.url
    })
    const suggestedName = getLinkedWorkItemSuggestedName(item)
    setModalName(suggestedName)
    modalLastAutoNameRef.current = suggestedName
    setModalAgentPrompt('')
    setModalNote('')
    setModalAttachmentPaths([])
    setModalCreateError(null)
    setModalLinkPopoverOpen(false)
    setModalLinkQuery('')
    setModalLinkDebouncedQuery('')
    setModalLinkDirectItem(null)
    setModalAdvancedOpen(false)
    setComposerModalOpen(true)
  }

  useEffect(() => {
    // Why: the composer should reflect the user's saved default once on mount
    // and after clearing a custom query, but only when there's no active custom
    // search to avoid clobbering their typed text.
    if (taskSearchInput.trim() || appliedTaskSearch.trim()) {
      return
    }

    const query = getTaskPresetQuery(defaultTaskViewPreset)
    if (activeTaskPreset !== defaultTaskViewPreset) {
      setActiveTaskPreset(defaultTaskViewPreset)
    }
    if (taskSearchInput !== query) {
      setTaskSearchInput(query)
    }
    if (appliedTaskSearch !== query) {
      setAppliedTaskSearch(query)
    }
  }, [activeTaskPreset, appliedTaskSearch, defaultTaskViewPreset, taskSearchInput])

  const handleApplyTaskSearch = useCallback((): void => {
    const trimmed = taskSearchInput.trim()
    setTaskSearchInput(trimmed)
    setAppliedTaskSearch(trimmed)
    setActiveTaskPreset(null)
    setTaskRefreshNonce((current) => current + 1)
  }, [taskSearchInput])

  const handleTaskSearchChange = useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
    const next = event.target.value
    setTaskSearchInput(next)
    setActiveTaskPreset(null)
  }, [])

  const handleSetDefaultTaskPreset = useCallback(
    (presetId: TaskViewPresetId): void => {
      // Why: the default task view is a durable preference, so right-clicking a
      // preset updates the persisted settings instead of only changing the
      // current page state.
      void updateSettings({ defaultTaskViewPreset: presetId }).catch(() => {
        toast.error('Failed to save default task view.')
      })
    },
    [updateSettings]
  )

  const handleTaskSearchKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === 'Enter') {
        event.preventDefault()
        handleApplyTaskSearch()
      }
    },
    [handleApplyTaskSearch]
  )

  const handleLinkPopoverChange = useCallback((open: boolean): void => {
    setLinkPopoverOpen(open)
    if (!open) {
      setLinkQuery('')
      setLinkDebouncedQuery('')
      setLinkDirectItem(null)
    }
  }, [])

  const handleModalLinkPopoverChange = useCallback((open: boolean): void => {
    setModalLinkPopoverOpen(open)
    if (!open) {
      setModalLinkQuery('')
      setModalLinkDebouncedQuery('')
      setModalLinkDirectItem(null)
    }
  }, [])

  const handleSelectLinkedItem = useCallback(
    (item: GitHubWorkItem): void => {
      applyLinkedWorkItem(item)
      handleLinkPopoverChange(false)
    },
    [applyLinkedWorkItem, handleLinkPopoverChange]
  )

  const handleSelectModalLinkedItem = useCallback(
    (item: GitHubWorkItem): void => {
      if (item.type === 'issue') {
        setModalLinkedIssue(String(item.number))
        setModalLinkedPR(null)
      } else {
        setModalLinkedIssue('')
        setModalLinkedPR(item.number)
      }
      setModalLinkedWorkItem({
        type: item.type,
        number: item.number,
        title: item.title,
        url: item.url
      })
      const suggestedName = getLinkedWorkItemSuggestedName(item)
      if (suggestedName && (!modalName.trim() || modalName === modalLastAutoNameRef.current)) {
        setModalName(suggestedName)
        modalLastAutoNameRef.current = suggestedName
      }
      handleModalLinkPopoverChange(false)
    },
    [handleModalLinkPopoverChange, modalName]
  )

  const handleNameChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      const nextName = event.target.value
      // Why: linked GitHub items should keep refreshing the suggested workspace
      // name only while the current value is still auto-managed. As soon as the
      // user edits the field by hand, later issue/PR selections must stop
      // clobbering it until they clear the field again.
      if (!nextName.trim()) {
        lastAutoNameRef.current = ''
      } else if (name !== lastAutoNameRef.current) {
        lastAutoNameRef.current = ''
      }
      setName(nextName)
      setCreateError(null)
    },
    [name]
  )

  const handleModalNameChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      const nextName = event.target.value
      if (!nextName.trim()) {
        modalLastAutoNameRef.current = ''
      } else if (modalName !== modalLastAutoNameRef.current) {
        modalLastAutoNameRef.current = ''
      }
      setModalName(nextName)
      setModalCreateError(null)
    },
    [modalName]
  )

  const handleAddAttachment = useCallback(async (): Promise<void> => {
    try {
      const selectedPath = await window.api.shell.pickAttachment()
      if (!selectedPath) {
        return
      }
      setAttachmentPaths((current) => {
        if (current.includes(selectedPath)) {
          return current
        }
        return [...current, selectedPath]
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to add attachment.'
      toast.error(message)
    }
  }, [])

  const handleAddModalAttachment = useCallback(async (): Promise<void> => {
    try {
      const selectedPath = await window.api.shell.pickAttachment()
      if (!selectedPath) {
        return
      }
      setModalAttachmentPaths((current) => {
        if (current.includes(selectedPath)) {
          return current
        }
        return [...current, selectedPath]
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to add attachment.'
      toast.error(message)
    }
  }, [])

  const handlePromptKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
      if (!mod || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'u') {
        return
      }

      // Why: the attachment picker should only steal Cmd/Ctrl+U while the user
      // is composing a prompt, so the shortcut is scoped to the textarea rather
      // than registered globally for the whole new-workspace surface.
      event.preventDefault()
      void handleAddAttachment()
    },
    [handleAddAttachment]
  )

  const handleModalPromptKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
      if (!mod || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'u') {
        return
      }

      event.preventDefault()
      void handleAddModalAttachment()
    },
    [handleAddModalAttachment]
  )

  const handleCreate = useCallback(async (): Promise<void> => {
    // Why: the full-page composer mirrors chat-first tools where the prompt or
    // selected task is the primary input. When the user leaves the name blank,
    // derive a stable branch/workspace name from the selected task or prompt
    // instead of forcing a duplicate manual field.
    const workspaceName = workspaceSeedName
    if (
      !repoId ||
      !workspaceName ||
      !selectedRepo ||
      shouldWaitForSetupCheck ||
      shouldWaitForIssueAutomationCheck ||
      (requiresExplicitSetupChoice && !setupDecision)
    ) {
      return
    }

    setCreateError(null)
    setCreating(true)
    try {
      const result = await createWorktree(
        repoId,
        workspaceName,
        undefined,
        (resolvedSetupDecision ?? 'inherit') as SetupDecision
      )
      const worktree = result.worktree

      try {
        const metaUpdates: {
          linkedIssue?: number
          linkedPR?: number
          comment?: string
        } = {}
        if (parsedLinkedIssueNumber !== null) {
          metaUpdates.linkedIssue = parsedLinkedIssueNumber
        }
        if (linkedPR !== null) {
          metaUpdates.linkedPR = linkedPR
        }
        if (note.trim()) {
          metaUpdates.comment = note.trim()
        }
        if (Object.keys(metaUpdates).length > 0) {
          await updateWorktreeMeta(worktree.id, metaUpdates)
        }
      } catch {
        console.error('Failed to update worktree meta after creation')
      }

      const issueCommand = shouldRunIssueAutomation
        ? {
            command: issueCommandTemplate.replace(/\{\{issue\}\}/g, String(parsedLinkedIssueNumber))
          }
        : undefined
      const startupPlan = buildAgentStartupPlan({
        agent: tuiAgent,
        prompt: startupPrompt,
        cmdOverrides: settings?.agentCmdOverrides ?? {},
        platform: CLIENT_PLATFORM
      })

      activateAndRevealWorktree(worktree.id, {
        setup: result.setup,
        issueCommand,
        ...(startupPlan ? { startup: { command: startupPlan.launchCommand } } : {})
      })
      if (startupPlan) {
        void ensureAgentStartupInTerminal({
          worktreeId: worktree.id,
          startup: startupPlan
        })
      }
      setSidebarOpen(true)
      if (settings?.rightSidebarOpenByDefault) {
        setRightSidebarTab('explorer')
        setRightSidebarOpen(true)
      }
      clearNewWorkspaceDraft()
      closeNewWorkspacePage()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create worktree.'
      setCreateError(message)
      toast.error(message)
    } finally {
      setCreating(false)
    }
  }, [
    clearNewWorkspaceDraft,
    closeNewWorkspacePage,
    createWorktree,
    issueCommandTemplate,
    linkedPR,
    note,
    parsedLinkedIssueNumber,
    repoId,
    requiresExplicitSetupChoice,
    resolvedSetupDecision,
    selectedRepo,
    settings?.agentCmdOverrides,
    settings?.rightSidebarOpenByDefault,
    setRightSidebarOpen,
    setRightSidebarTab,
    setSidebarOpen,
    setupDecision,
    tuiAgent,
    shouldRunIssueAutomation,
    shouldWaitForIssueAutomationCheck,
    shouldWaitForSetupCheck,
    startupPrompt,
    updateWorktreeMeta,
    workspaceSeedName
  ])

  const handleModalCreate = useCallback(async (): Promise<void> => {
    const workspaceName = modalWorkspaceSeedName
    if (
      !repoId ||
      !workspaceName ||
      !selectedRepo ||
      shouldWaitForSetupCheck ||
      (requiresExplicitSetupChoice && !modalSetupDecision)
    ) {
      return
    }

    setModalCreateError(null)
    setModalCreating(true)
    try {
      const result = await createWorktree(
        repoId,
        workspaceName,
        undefined,
        (resolvedModalSetupDecision ?? 'inherit') as SetupDecision
      )
      const worktree = result.worktree

      try {
        const metaUpdates: {
          linkedIssue?: number
          linkedPR?: number
          comment?: string
        } = {}
        if (parsedModalLinkedIssueNumber !== null) {
          metaUpdates.linkedIssue = parsedModalLinkedIssueNumber
        }
        if (modalLinkedPR !== null) {
          metaUpdates.linkedPR = modalLinkedPR
        }
        if (modalNote.trim()) {
          metaUpdates.comment = modalNote.trim()
        }
        if (Object.keys(metaUpdates).length > 0) {
          await updateWorktreeMeta(worktree.id, metaUpdates)
        }
      } catch {
        console.error('Failed to update worktree meta after creation')
      }

      const startupPlan = buildAgentStartupPlan({
        agent: modalTuiAgent,
        prompt: modalStartupPrompt,
        cmdOverrides: settings?.agentCmdOverrides ?? {},
        platform: CLIENT_PLATFORM
      })

      activateAndRevealWorktree(worktree.id, {
        setup: result.setup,
        ...(startupPlan ? { startup: { command: startupPlan.launchCommand } } : {})
      })
      if (startupPlan) {
        void ensureAgentStartupInTerminal({
          worktreeId: worktree.id,
          startup: startupPlan
        })
      }
      setSidebarOpen(true)
      if (settings?.rightSidebarOpenByDefault) {
        setRightSidebarTab('explorer')
        setRightSidebarOpen(true)
      }
      clearNewWorkspaceDraft()
      closeNewWorkspacePage()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create worktree.'
      setModalCreateError(message)
      toast.error(message)
    } finally {
      setModalCreating(false)
    }
  }, [
    clearNewWorkspaceDraft,
    closeNewWorkspacePage,
    createWorktree,
    modalLinkedPR,
    modalNote,
    modalSetupDecision,
    modalStartupPrompt,
    modalTuiAgent,
    modalWorkspaceSeedName,
    parsedModalLinkedIssueNumber,
    repoId,
    requiresExplicitSetupChoice,
    resolvedModalSetupDecision,
    selectedRepo,
    settings?.agentCmdOverrides,
    settings?.rightSidebarOpenByDefault,
    setRightSidebarOpen,
    setRightSidebarTab,
    setSidebarOpen,
    shouldWaitForSetupCheck,
    updateWorktreeMeta
  ])

  const createDisabled =
    !repoId ||
    !workspaceSeedName ||
    creating ||
    shouldWaitForSetupCheck ||
    shouldWaitForIssueAutomationCheck ||
    (requiresExplicitSetupChoice && !setupDecision)
  const modalCreateDisabled =
    !repoId ||
    !modalWorkspaceSeedName ||
    modalCreating ||
    shouldWaitForSetupCheck ||
    (requiresExplicitSetupChoice && !modalSetupDecision)

  const handleDiscardDraft = useCallback((): void => {
    clearNewWorkspaceDraft()
    closeNewWorkspacePage()
  }, [clearNewWorkspaceDraft, closeNewWorkspacePage])

  const handleComposerRepoChange = useCallback((value: string): void => {
    startTransition(() => {
      setRepoId(value)
      setLinkedIssue('')
      setLinkedPR(null)
      setLinkedWorkItem(null)
      setModalLinkedIssue('')
      setModalLinkedPR(null)
      setModalLinkedWorkItem(null)
    })
  }, [])

  const handleRemoveLinkedWorkItem = useCallback((): void => {
    setLinkedWorkItem(null)
    setLinkedIssue('')
    setLinkedPR(null)
    if (name === lastAutoNameRef.current) {
      lastAutoNameRef.current = ''
    }
  }, [name])

  const handleOpenAgentSettings = useCallback((): void => {
    openSettingsTarget({ pane: 'agents', repoId: null })
    openSettingsPage()
  }, [openSettingsPage, openSettingsTarget])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' && event.key !== 'Escape') {
        return
      }

      const target = event.target
      if (!(target instanceof HTMLElement)) {
        return
      }

      if (event.key === 'Escape') {
        // Why: Esc should first dismiss the focused control so users can back
        // out of text entry without accidentally closing the whole composer.
        // Once focus is already outside an input, Esc becomes the discard shortcut.
        if (composerModalOpen) {
          if (
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement ||
            target instanceof HTMLSelectElement ||
            target.isContentEditable
          ) {
            event.preventDefault()
            target.blur()
          }
          return
        }

        if (
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement ||
          target.isContentEditable
        ) {
          event.preventDefault()
          target.blur()
          return
        }

        event.preventDefault()
        handleDiscardDraft()
        return
      }

      const activeComposerRef = composerModalOpen ? modalComposerRef : composerRef
      if (!activeComposerRef.current?.contains(target)) {
        return
      }

      const activeCreateDisabled = composerModalOpen ? modalCreateDisabled : createDisabled
      if (activeCreateDisabled) {
        return
      }

      if (target instanceof HTMLTextAreaElement && event.shiftKey) {
        return
      }

      event.preventDefault()
      if (composerModalOpen) {
        void handleModalCreate()
        return
      }
      void handleCreate()
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [
    composerModalOpen,
    createDisabled,
    handleCreate,
    handleDiscardDraft,
    handleModalCreate,
    modalCreateDisabled
  ])

  return (
    <div className="relative flex h-full min-h-0 flex-1 overflow-hidden bg-background dark:bg-[#1a1a1a] text-foreground">
      <LightRays
        count={6}
        color="rgba(120, 160, 255, 0.15)"
        blur={44}
        speed={16}
        length="60vh"
        className="z-0"
      />

      {selectedRepo?.badgeColor && (
        <div
          className="pointer-events-none absolute inset-0 z-0 opacity-30 transition-opacity duration-700 ease-in-out"
          style={{
            background: `radial-gradient(circle at top right, ${selectedRepo.badgeColor}, transparent 75%)`
          }}
        />
      )}

      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
        <div className="flex-none flex items-center justify-end px-5 py-3 md:px-8 md:py-4">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 rounded-full z-10"
                onClick={handleDiscardDraft}
                aria-label="Discard draft and go back"
              >
                <X className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              Discard draft · Esc
            </TooltipContent>
          </Tooltip>
        </div>

        <div className="mx-auto flex w-full max-w-[1120px] flex-1 flex-col min-h-0 px-5 pb-5 md:px-8 md:pb-7">
          <div className="flex-none flex flex-col gap-5">
            <section className="mx-auto w-full max-w-[860px] border-b border-border/50 pb-5">
              <NewWorkspaceComposerCard
                composerRef={composerRef}
                nameInputRef={nameInputRef}
                promptTextareaRef={promptTextareaRef}
                eligibleRepos={eligibleRepos}
                repoId={repoId}
                onRepoChange={handleComposerRepoChange}
                name={name}
                onNameChange={handleNameChange}
                agentPrompt={agentPrompt}
                onAgentPromptChange={setAgentPrompt}
                onPromptKeyDown={handlePromptKeyDown}
                attachmentPaths={attachmentPaths}
                getAttachmentLabel={getAttachmentLabel}
                onAddAttachment={() => void handleAddAttachment()}
                onRemoveAttachment={(pathValue) =>
                  setAttachmentPaths((current) =>
                    current.filter((currentPath) => currentPath !== pathValue)
                  )
                }
                addAttachmentShortcut={ADD_ATTACHMENT_SHORTCUT}
                linkedWorkItem={linkedWorkItem}
                onRemoveLinkedWorkItem={handleRemoveLinkedWorkItem}
                linkPopoverOpen={linkPopoverOpen}
                onLinkPopoverOpenChange={handleLinkPopoverChange}
                linkQuery={linkQuery}
                onLinkQueryChange={setLinkQuery}
                filteredLinkItems={filteredLinkItems}
                linkItemsLoading={linkItemsLoading}
                linkDirectLoading={linkDirectLoading}
                normalizedLinkQuery={normalizedLinkQuery}
                onSelectLinkedItem={handleSelectLinkedItem}
                tuiAgent={tuiAgent}
                onTuiAgentChange={setTuiAgent}
                detectedAgentIds={detectedAgentIds as Set<TuiAgent> | null}
                onOpenAgentSettings={handleOpenAgentSettings}
                advancedOpen={advancedOpen}
                onToggleAdvanced={() => setAdvancedOpen((current) => !current)}
                createDisabled={createDisabled}
                creating={creating}
                onCreate={() => void handleCreate()}
                note={note}
                onNoteChange={setNote}
                setupConfig={setupConfig}
                requiresExplicitSetupChoice={requiresExplicitSetupChoice}
                setupDecision={setupDecision}
                onSetupDecisionChange={setSetupDecision}
                shouldWaitForSetupCheck={shouldWaitForSetupCheck}
                resolvedSetupDecision={resolvedSetupDecision}
                createError={createError}
              />
            </section>

            <Dialog open={composerModalOpen} onOpenChange={setComposerModalOpen}>
              <DialogContent
                className="max-w-[calc(100vw-2rem)] border-none bg-transparent p-0 shadow-none sm:max-w-[880px]"
                showCloseButton={false}
                onOpenAutoFocus={(event) => {
                  event.preventDefault()
                  modalPromptTextareaRef.current?.focus()
                }}
              >
                <div className="mb-2 flex justify-end pr-1 text-xs text-muted-foreground">
                  Esc closes
                </div>
                <NewWorkspaceComposerCard
                  containerClassName="bg-card/98 shadow-2xl supports-[backdrop-filter]:bg-card/95"
                  composerRef={modalComposerRef}
                  nameInputRef={modalNameInputRef}
                  promptTextareaRef={modalPromptTextareaRef}
                  eligibleRepos={eligibleRepos}
                  repoId={repoId}
                  onRepoChange={handleComposerRepoChange}
                  name={modalName}
                  onNameChange={handleModalNameChange}
                  agentPrompt={modalAgentPrompt}
                  onAgentPromptChange={setModalAgentPrompt}
                  onPromptKeyDown={handleModalPromptKeyDown}
                  attachmentPaths={modalAttachmentPaths}
                  getAttachmentLabel={getAttachmentLabel}
                  onAddAttachment={() => void handleAddModalAttachment()}
                  onRemoveAttachment={(pathValue) =>
                    setModalAttachmentPaths((current) =>
                      current.filter((currentPath) => currentPath !== pathValue)
                    )
                  }
                  addAttachmentShortcut={ADD_ATTACHMENT_SHORTCUT}
                  linkedWorkItem={modalLinkedWorkItem}
                  onRemoveLinkedWorkItem={() => {
                    setModalLinkedWorkItem(null)
                    setModalLinkedIssue('')
                    setModalLinkedPR(null)
                    if (modalName === modalLastAutoNameRef.current) {
                      modalLastAutoNameRef.current = ''
                    }
                  }}
                  linkPopoverOpen={modalLinkPopoverOpen}
                  onLinkPopoverOpenChange={handleModalLinkPopoverChange}
                  linkQuery={modalLinkQuery}
                  onLinkQueryChange={setModalLinkQuery}
                  filteredLinkItems={filteredModalLinkItems}
                  linkItemsLoading={linkItemsLoading}
                  linkDirectLoading={modalLinkDirectLoading}
                  normalizedLinkQuery={normalizedModalLinkQuery}
                  onSelectLinkedItem={handleSelectModalLinkedItem}
                  tuiAgent={modalTuiAgent}
                  onTuiAgentChange={setModalTuiAgent}
                  detectedAgentIds={detectedAgentIds as Set<TuiAgent> | null}
                  onOpenAgentSettings={handleOpenAgentSettings}
                  advancedOpen={modalAdvancedOpen}
                  onToggleAdvanced={() => setModalAdvancedOpen((current) => !current)}
                  createDisabled={modalCreateDisabled}
                  creating={modalCreating}
                  onCreate={() => void handleModalCreate()}
                  note={modalNote}
                  onNoteChange={setModalNote}
                  setupConfig={setupConfig}
                  requiresExplicitSetupChoice={requiresExplicitSetupChoice}
                  setupDecision={modalSetupDecision}
                  onSetupDecisionChange={setModalSetupDecision}
                  shouldWaitForSetupCheck={shouldWaitForSetupCheck}
                  resolvedSetupDecision={resolvedModalSetupDecision}
                  createError={modalCreateError}
                />
              </DialogContent>
            </Dialog>

            <section className="flex flex-col gap-4">
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {SOURCE_OPTIONS.map((source) => {
                      const active = taskSource === source.id
                      return (
                        <Tooltip key={source.id}>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              disabled={source.disabled}
                              onClick={() => setTaskSource(source.id)}
                              aria-label={source.label}
                              className={cn(
                                'group flex h-11 w-11 items-center justify-center rounded-xl border transition',
                                active
                                  ? 'border-border/50 bg-background/50 backdrop-blur-md supports-[backdrop-filter]:bg-background/50'
                                  : 'border-border/50 bg-transparent hover:bg-muted/40',
                                source.disabled && 'cursor-not-allowed opacity-55'
                              )}
                            >
                              <source.Icon className="size-4 text-foreground" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" sideOffset={6}>
                            {source.label}
                          </TooltipContent>
                        </Tooltip>
                      )
                    })}
                  </div>
                  <div className="w-[240px]">
                    <RepoCombobox
                      repos={eligibleRepos}
                      value={repoId}
                      onValueChange={(value) => {
                        startTransition(() => {
                          setRepoId(value)
                          setLinkedIssue('')
                          setLinkedPR(null)
                          setLinkedWorkItem(null)
                        })
                      }}
                      placeholder="Select a repository"
                      triggerClassName="h-11 w-full rounded-[10px] border border-border/50 bg-background/50 backdrop-blur-md px-3 text-sm font-medium shadow-sm transition hover:bg-muted/50 focus:ring-2 focus:ring-ring/20 focus:outline-none supports-[backdrop-filter]:bg-background/50"
                    />
                  </div>
                </div>

                {taskSource === 'github' && (
                  <div className="rounded-[16px] border border-border/50 bg-background/40 backdrop-blur-md p-4 shadow-sm supports-[backdrop-filter]:bg-background/40">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex flex-wrap gap-2">
                        {TASK_QUERY_PRESETS.map((option) => {
                          const active = activeTaskPreset === option.id
                          return (
                            <button
                              key={option.id}
                              type="button"
                              onClick={() => {
                                const query = option.query
                                setTaskSearchInput(query)
                                setAppliedTaskSearch(query)
                                setActiveTaskPreset(option.id)
                                setTaskRefreshNonce((current) => current + 1)
                              }}
                              onContextMenu={(event) => {
                                event.preventDefault()
                                handleSetDefaultTaskPreset(option.id)
                              }}
                              className={cn(
                                'rounded-xl border px-3 py-2 text-sm transition',
                                active
                                  ? 'border-border/50 bg-foreground/90 text-background backdrop-blur-md'
                                  : 'border-border/50 bg-transparent text-foreground hover:bg-muted/50'
                              )}
                            >
                              {option.label}
                            </button>
                          )
                        })}
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="outline"
                              size="icon"
                              onClick={() => setTaskRefreshNonce((current) => current + 1)}
                              disabled={tasksLoading}
                              aria-label="Refresh GitHub work"
                              className="border-border/50 bg-transparent hover:bg-muted/50 backdrop-blur-md supports-[backdrop-filter]:bg-transparent"
                            >
                              {tasksLoading ? (
                                <LoaderCircle className="size-4 animate-spin" />
                              ) : (
                                <RefreshCw className="size-4" />
                              )}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" sideOffset={6}>
                            Refresh GitHub work
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </div>

                    <div className="mt-4 flex flex-wrap items-center gap-3">
                      <div className="relative min-w-[320px] flex-1">
                        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          value={taskSearchInput}
                          onChange={handleTaskSearchChange}
                          onKeyDown={handleTaskSearchKeyDown}
                          placeholder="GitHub search, e.g. assignee:@me is:open"
                          className="h-10 border-border/50 bg-background/50 pl-10 pr-10 backdrop-blur-md supports-[backdrop-filter]:bg-background/50"
                        />
                        {taskSearchInput || appliedTaskSearch ? (
                          <button
                            type="button"
                            aria-label="Clear search"
                            onClick={() => {
                              setTaskSearchInput('')
                              setAppliedTaskSearch('')
                              setActiveTaskPreset(null)
                              setTaskRefreshNonce((current) => current + 1)
                            }}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition hover:text-foreground"
                          >
                            <X className="size-4" />
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </section>
          </div>

          {taskSource === 'github' ? (
            <div className="mt-4 flex flex-1 flex-col min-h-0 rounded-[16px] border border-border/50 bg-background/30 backdrop-blur-md supports-[backdrop-filter]:bg-background/30 overflow-hidden shadow-sm">
              <div className="flex-none hidden grid-cols-[96px_minmax(0,1.8fr)_minmax(140px,1fr)_150px_120px_90px] gap-4 border-b border-border/50 px-4 py-3 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground lg:grid">
                <span>ID</span>
                <span>Title / Context</span>
                <span>Source Branch</span>
                <span>System Status</span>
                <span>Updated</span>
                <span />
              </div>

              <div
                className="flex-1 overflow-y-auto scrollbar-sleek"
                style={{ scrollbarGutter: 'stable' }}
              >
                {tasksError ? (
                  <div className="border-b border-border px-4 py-4 text-sm text-destructive">
                    {tasksError}
                  </div>
                ) : null}

                {!tasksLoading && filteredWorkItems.length === 0 ? (
                  <div className="px-4 py-10 text-center">
                    <p className="text-base font-medium text-foreground">No matching GitHub work</p>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Change the query or clear it.
                    </p>
                  </div>
                ) : null}

                <div className="divide-y divide-border/50">
                  {filteredWorkItems.map((item) => {
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => handleSelectWorkItem(item)}
                        className="grid w-full gap-4 px-4 py-4 text-left transition hover:bg-muted/40 lg:grid-cols-[96px_minmax(0,1.8fr)_minmax(140px,1fr)_150px_120px_90px]"
                      >
                        <div className="flex items-center">
                          <span className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-muted/40 px-2.5 py-1.5 text-muted-foreground">
                            {item.type === 'pr' ? (
                              <GitPullRequest className="size-3.5" />
                            ) : (
                              <CircleDot className="size-3.5" />
                            )}
                            <span className="font-mono text-[13px] font-normal">
                              #{item.number}
                            </span>
                          </span>
                        </div>

                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            {item.type === 'pr' ? (
                              <GitPullRequest className="size-4 text-muted-foreground" />
                            ) : (
                              <CircleDot className="size-4 text-muted-foreground" />
                            )}
                            <h3 className="truncate text-[15px] font-semibold text-foreground">
                              {item.title}
                            </h3>
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                            <span>{item.author ?? 'unknown author'}</span>
                            <span>{selectedRepo?.displayName}</span>
                            {item.labels.slice(0, 3).map((label) => (
                              <span
                                key={label}
                                className="rounded-full border border-border/50 bg-background/50 backdrop-blur-md px-2 py-0.5 text-[11px] text-muted-foreground supports-[backdrop-filter]:bg-background/50"
                              >
                                {label}
                              </span>
                            ))}
                          </div>
                        </div>

                        <div className="min-w-0 flex items-center text-sm text-muted-foreground">
                          <span className="truncate">
                            {item.branchName || item.baseRefName || 'workspace/default'}
                          </span>
                        </div>

                        <div className="flex items-center">
                          <span
                            className={cn(
                              'rounded-full border px-2.5 py-1 text-xs font-medium',
                              getTaskStatusTone(item)
                            )}
                          >
                            {getTaskStatusLabel(item)}
                          </span>
                        </div>

                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="flex items-center text-sm text-muted-foreground">
                              {formatRelativeTime(item.updatedAt)}
                            </div>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" sideOffset={6}>
                            {new Date(item.updatedAt).toLocaleString()}
                          </TooltipContent>
                        </Tooltip>

                        <div className="flex items-center justify-start gap-1 lg:justify-end">
                          <span className="inline-flex items-center gap-1 rounded-xl border border-border/50 bg-background/50 backdrop-blur-md px-3 py-1.5 text-sm text-foreground supports-[backdrop-filter]:bg-background/50">
                            Use
                            <ArrowRight className="size-4" />
                          </span>
                          <DropdownMenu modal={false}>
                            <DropdownMenuTrigger asChild>
                              <button
                                type="button"
                                onClick={(e) => e.stopPropagation()}
                                className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted/60 hover:text-foreground"
                                aria-label="More actions"
                              >
                                <EllipsisVertical className="size-4" />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                              <DropdownMenuItem onSelect={() => window.open(item.url, '_blank')}>
                                <ExternalLink className="size-4" />
                                Open in browser
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-4 px-1 py-6">
              <p className="text-sm text-muted-foreground">Coming soon</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
