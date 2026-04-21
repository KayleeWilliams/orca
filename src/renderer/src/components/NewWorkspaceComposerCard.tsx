/* eslint-disable max-lines -- Why: this component intentionally keeps the full
composer card markup together so the inline and modal variants share one UI
surface without splitting the controlled form into hard-to-follow fragments. */
import React from 'react'
import {
  Check,
  ChevronDown,
  CornerDownLeft,
  Folder,
  FolderPlus,
  LoaderCircle,
  Settings2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import RepoCombobox from '@/components/repo/RepoCombobox'
import { AGENT_CATALOG, AgentIcon } from '@/lib/agent-catalog'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import type { TuiAgent } from '../../../shared/types'
import { isGitRepoKind } from '../../../shared/repo-kind'

type RepoOption = React.ComponentProps<typeof RepoCombobox>['repos'][number]

type NewWorkspaceComposerCardProps = {
  containerClassName?: string
  composerRef?: React.RefObject<HTMLDivElement | null>
  nameInputRef?: React.RefObject<HTMLInputElement | null>
  repoAutoOpen?: boolean
  quickAgent: TuiAgent | null
  onQuickAgentChange: (agent: TuiAgent | null) => void
  eligibleRepos: RepoOption[]
  repoId: string
  onRepoChange: (value: string) => void
  name: string
  onNameChange: (event: React.ChangeEvent<HTMLInputElement>) => void
  detectedAgentIds: Set<TuiAgent> | null
  onOpenAgentSettings: () => void
  advancedOpen: boolean
  onToggleAdvanced: () => void
  createDisabled: boolean
  creating: boolean
  onCreate: () => void
  note: string
  onNoteChange: (value: string) => void
  setupConfig: { source: 'yaml' | 'legacy'; command: string } | null
  requiresExplicitSetupChoice: boolean
  setupDecision: 'run' | 'skip' | null
  onSetupDecisionChange: (value: 'run' | 'skip') => void
  shouldWaitForSetupCheck: boolean
  resolvedSetupDecision: 'run' | 'skip' | null
  createError: string | null
}

function renderSetupYamlPreview(command: string): React.JSX.Element[] {
  const lines = ['scripts:', '  setup: |', ...command.split('\n').map((line) => `    ${line}`)]

  return lines.map((line, index) => {
    const keyMatch = line.match(/^(\s*)([a-zA-Z][\w-]*)(:\s*)(\|)?$/)
    if (keyMatch) {
      return (
        <div key={`${line}-${index}`} className="whitespace-pre">
          <span className="text-muted-foreground">{keyMatch[1]}</span>
          <span className="font-semibold text-sky-600 dark:text-sky-300">{keyMatch[2]}</span>
          <span className="text-muted-foreground">{keyMatch[3]}</span>
          {keyMatch[4] ? (
            <span className="text-amber-600 dark:text-amber-300">{keyMatch[4]}</span>
          ) : null}
        </div>
      )
    }

    return (
      <div key={`${line}-${index}`} className="whitespace-pre">
        <span className="text-emerald-700 dark:text-emerald-300/95">{line}</span>
      </div>
    )
  })
}

function SetupCommandPreview({
  setupConfig,
  headerAction
}: {
  setupConfig: { source: 'yaml' | 'legacy'; command: string }
  headerAction?: React.ReactNode
}): React.JSX.Element {
  if (setupConfig.source === 'yaml') {
    return (
      <div className="rounded-2xl border border-border/60 bg-muted/40 shadow-inner">
        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            orca.yaml
          </div>
          {headerAction}
        </div>
        <pre className="overflow-x-auto px-4 py-4 font-mono text-[12px] leading-6 text-foreground">
          {renderSetupYamlPreview(setupConfig.command)}
        </pre>
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-border/60 bg-muted/35 px-4 py-3 shadow-inner">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          Legacy setup command
        </div>
        {headerAction}
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-foreground">
        {setupConfig.command}
      </pre>
    </div>
  )
}

function useComposerFileDragOver(): {
  isFileDragOver: boolean
  dragHandlers: {
    onDragEnter: (event: React.DragEvent<HTMLDivElement>) => void
    onDragLeave: (event: React.DragEvent<HTMLDivElement>) => void
  }
} {
  const [isFileDragOver, setIsFileDragOver] = React.useState(false)
  const dragCounterRef = React.useRef(0)

  const reset = React.useCallback(() => {
    dragCounterRef.current = 0
    setIsFileDragOver(false)
  }, [])

  const onDragEnter = React.useCallback((event: React.DragEvent<HTMLDivElement>): void => {
    // Why: "Files" is the DataTransfer type the OS adds for native file drags;
    // internal in-app drags (text/x-orca-file-path) must not trigger the
    // attachment-drop highlight so they still route to their own handlers.
    if (!event.dataTransfer.types.includes('Files')) {
      return
    }
    if (event.dataTransfer.types.includes('text/x-orca-file-path')) {
      return
    }
    dragCounterRef.current += 1
    setIsFileDragOver(true)
  }, [])

  const onDragLeave = React.useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      if (!event.dataTransfer.types.includes('Files')) {
        return
      }
      // Why: mirror the onDragEnter guard so internal in-app drags (which may
      // carry both 'Files' and 'text/x-orca-file-path' types) don't decrement
      // the counter when enter skipped incrementing it — otherwise the counter
      // goes negative and the native-drag highlight state desyncs.
      if (event.dataTransfer.types.includes('text/x-orca-file-path')) {
        return
      }
      dragCounterRef.current -= 1
      if (dragCounterRef.current <= 0) {
        reset()
      }
    },
    [reset]
  )

  // Why: the preload bridge calls stopPropagation on native `drop` events so
  // React's onDrop never fires on the composer card. Listen at the document
  // level (also capture-phase) to reset the drag highlight whenever any drop
  // or dragend occurs anywhere in the window.
  React.useEffect(() => {
    const handler = (): void => {
      reset()
    }
    document.addEventListener('drop', handler, true)
    document.addEventListener('dragend', handler, true)
    return () => {
      document.removeEventListener('drop', handler, true)
      document.removeEventListener('dragend', handler, true)
    }
  }, [reset])

  return {
    isFileDragOver,
    dragHandlers: { onDragEnter, onDragLeave }
  }
}

export default function NewWorkspaceComposerCard({
  containerClassName,
  composerRef,
  nameInputRef,
  repoAutoOpen = false,
  quickAgent,
  onQuickAgentChange,
  eligibleRepos,
  repoId,
  onRepoChange,
  name,
  onNameChange,
  detectedAgentIds,
  onOpenAgentSettings,
  advancedOpen,
  onToggleAdvanced,
  createDisabled,
  creating,
  onCreate,
  note,
  onNoteChange,
  setupConfig,
  requiresExplicitSetupChoice,
  setupDecision,
  onSetupDecisionChange,
  shouldWaitForSetupCheck,
  resolvedSetupDecision,
  createError
}: NewWorkspaceComposerCardProps): React.JSX.Element {
  const { isFileDragOver, dragHandlers } = useComposerFileDragOver()
  const addRepo = useAppStore((s) => s.addRepo)
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const [isAddingRepo, setIsAddingRepo] = React.useState(false)

  const focusNameInput = React.useCallback(() => {
    // Why: after the repo picker commits a choice, moving focus to the name
    // field keeps the keyboard flow progressing through the form instead of
    // trapping the user in the repo popover interaction.
    requestAnimationFrame(() => {
      nameInputRef?.current?.focus()
    })
  }, [nameInputRef])

  const visibleQuickAgents = React.useMemo(
    () =>
      AGENT_CATALOG.filter((agent) => detectedAgentIds === null || detectedAgentIds.has(agent.id)),
    [detectedAgentIds]
  )

  const handleAddRepo = React.useCallback(async (): Promise<void> => {
    if (isAddingRepo) {
      return
    }
    setIsAddingRepo(true)
    try {
      const repo = await addRepo()
      if (!repo) {
        return
      }
      if (isGitRepoKind(repo)) {
        await fetchWorktrees(repo.id)
      }
      onRepoChange(repo.id)
      focusNameInput()
    } finally {
      setIsAddingRepo(false)
    }
  }, [addRepo, fetchWorktrees, focusNameInput, isAddingRepo, onRepoChange])

  return (
    <div className="grid gap-3">
      <div
        ref={composerRef}
        // Why: preload classifies native OS file drops by the nearest
        // `data-native-file-drop-target` marker in the composedPath. Tagging
        // the composer root makes drops anywhere on the card (modal or full
        // page) route to the composer attachment handler instead of falling
        // back to the default editor-open behavior.
        data-native-file-drop-target="composer"
        onDragEnter={dragHandlers.onDragEnter}
        onDragLeave={dragHandlers.onDragLeave}
        className={cn(
          'rounded-2xl border border-border/50 bg-background/40 p-3 shadow-lg backdrop-blur-xl supports-[backdrop-filter]:bg-background/40 transition',
          isFileDragOver && 'border-ring ring-2 ring-ring/30',
          containerClassName
        )}
      >
        <div className="grid gap-3">
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <div className="flex items-center justify-between gap-2 px-1">
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Repository
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      disabled={isAddingRepo}
                      onClick={() => void handleAddRepo()}
                      className="size-5 shrink-0 rounded-sm text-muted-foreground hover:text-foreground"
                      aria-label={
                        isAddingRepo ? 'Adding folder or repository' : 'Add folder or repository'
                      }
                    >
                      <FolderPlus className="size-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={6}>
                    Add repo
                  </TooltipContent>
                </Tooltip>
              </div>
              <RepoCombobox
                repos={eligibleRepos}
                value={repoId}
                onValueChange={onRepoChange}
                onValueSelected={focusNameInput}
                placeholder="Choose repository"
                triggerClassName="h-9"
                autoFocusTriggerOnMount={repoAutoOpen}
                showStandaloneAddButton={false}
              />
            </div>
            <label className="grid max-w-full gap-1.5">
              <span className="px-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Workspace
              </span>
              <input
                ref={nameInputRef}
                type="text"
                value={name}
                onChange={onNameChange}
                placeholder="[Optional] Workspace name"
                className="h-9 min-w-0 flex-1 bg-transparent px-1 text-[14px] font-medium text-foreground outline-none placeholder:text-muted-foreground/80"
              />
            </label>
            <div className="grid gap-1.5">
              <div className="flex items-center justify-between gap-2 px-1">
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Agent
                </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      onClick={onOpenAgentSettings}
                      className="size-5 shrink-0 rounded-sm text-muted-foreground hover:text-foreground"
                      aria-label="Open agent settings"
                    >
                      <Settings2 className="size-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={6}>
                    Configure agents
                  </TooltipContent>
                </Tooltip>
              </div>
              <Select
                value={quickAgent ?? '__none__'}
                onValueChange={(value) => {
                  onQuickAgentChange(value === '__none__' ? null : (value as TuiAgent))
                }}
              >
                <SelectTrigger size="sm" className="h-9 min-w-[148px]">
                  <SelectValue>
                    <span className="flex items-center gap-2">
                      {quickAgent ? (
                        <AgentIcon agent={quickAgent} />
                      ) : (
                        <Folder className="size-4" />
                      )}
                      <span>
                        {quickAgent
                          ? (AGENT_CATALOG.find((a) => a.id === quickAgent)?.label ?? quickAgent)
                          : 'No agent'}
                      </span>
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem value="__none__">
                    <span className="flex items-center gap-2">
                      <Folder className="size-4" />
                      <span>No agent</span>
                    </span>
                  </SelectItem>
                  {visibleQuickAgents.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      <span className="flex items-center gap-2">
                        <AgentIcon agent={option.id} />
                        <span>{option.label}</span>
                      </span>
                    </SelectItem>
                  ))}
                  <div className="border-t border-border/50 px-1 pb-0.5 pt-1">
                    <button
                      type="button"
                      className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={onOpenAgentSettings}
                    >
                      Manage agents
                      <svg
                        className="size-3"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path d="M5 12h14M12 5l7 7-7 7" />
                      </svg>
                    </button>
                  </div>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <Button type="button" variant="ghost" size="sm" onClick={onToggleAdvanced}>
              Advanced
              <ChevronDown
                className={cn('size-4 transition-transform', advancedOpen && 'rotate-180')}
              />
            </Button>

            <div className="flex justify-end">
              <Button onClick={() => void onCreate()} disabled={createDisabled} size="sm">
                {creating ? <LoaderCircle className="size-4 animate-spin" /> : null}
                Create Workspace
                <span className="ml-1 rounded-full border border-white/20 p-1 text-current/80">
                  <CornerDownLeft className="size-3" />
                </span>
              </Button>
            </div>
          </div>

          <div
            className={cn(
              'grid overflow-hidden transition-[grid-template-rows,opacity] duration-200 ease-out',
              advancedOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
            )}
            aria-hidden={!advancedOpen}
          >
            <div className="min-h-0 px-3 pt-3">
              <div className="grid gap-5 pb-3">
                <div className="grid gap-1.5">
                  <label className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    Note
                  </label>
                  <Input
                    value={note}
                    onChange={(event) => onNoteChange(event.target.value)}
                    placeholder="Write a note"
                    className="h-10"
                  />
                </div>

                {setupConfig ? (
                  <div className="grid gap-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <label className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        Setup script
                      </label>
                      <span className="rounded-full border border-border/70 bg-muted/45 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-foreground/70 shadow-sm">
                        {setupConfig.source === 'yaml' ? 'orca.yaml' : 'legacy hooks'}
                      </span>
                    </div>

                    {/* Why: `orca.yaml` is the committed source of truth for shared setup,
                        so the preview reconstructs the real YAML shape instead of showing a raw
                        shell blob that hides where the command came from. */}
                    <SetupCommandPreview
                      setupConfig={setupConfig}
                      headerAction={
                        requiresExplicitSetupChoice ? null : (
                          <label className="group flex items-center gap-2 text-xs text-foreground">
                            <span
                              className={cn(
                                'flex size-4 items-center justify-center rounded-[3px] border transition shadow-sm',
                                resolvedSetupDecision === 'run'
                                  ? 'border-emerald-500/60 bg-emerald-500 text-white'
                                  : 'border-foreground/20 bg-background dark:border-white/20 dark:bg-muted/10'
                              )}
                            >
                              <Check
                                className={cn(
                                  'size-3 transition-opacity',
                                  resolvedSetupDecision === 'run' ? 'opacity-100' : 'opacity-0'
                                )}
                              />
                            </span>
                            <input
                              type="checkbox"
                              checked={resolvedSetupDecision === 'run'}
                              onChange={(event) =>
                                onSetupDecisionChange(event.target.checked ? 'run' : 'skip')
                              }
                              className="sr-only"
                            />
                            <span>Run setup command</span>
                          </label>
                        )
                      }
                    />

                    {requiresExplicitSetupChoice ? (
                      <div className="grid gap-2.5">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                          Run setup now?
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            type="button"
                            onClick={() => onSetupDecisionChange('run')}
                            variant={setupDecision === 'run' ? 'default' : 'outline'}
                            size="sm"
                          >
                            Run setup now
                          </Button>
                          <Button
                            type="button"
                            onClick={() => onSetupDecisionChange('skip')}
                            variant={setupDecision === 'skip' ? 'secondary' : 'outline'}
                            size="sm"
                          >
                            Skip for now
                          </Button>
                        </div>
                        {!setupDecision ? (
                          <div className="text-xs text-muted-foreground">
                            {shouldWaitForSetupCheck
                              ? 'Checking setup configuration...'
                              : 'Choose whether to run setup before creating this workspace.'}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>

      {createError ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {createError}
        </div>
      ) : null}
    </div>
  )
}
