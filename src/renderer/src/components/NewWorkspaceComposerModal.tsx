import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import NewWorkspaceComposerCard from '@/components/NewWorkspaceComposerCard'
import AgentSettingsDialog from '@/components/agent/AgentSettingsDialog'
import CreateFromTab from '@/components/new-workspace/CreateFromTab'
import { useComposerState } from '@/hooks/useComposerState'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { shouldSuppressEnterSubmit } from '@/lib/new-workspace-enter-guard'
import { cn } from '@/lib/utils'
import type { TuiAgent } from '../../../shared/types'

type ComposerModalData = {
  prefilledName?: string
  initialRepoId?: string
  linkedWorkItem?: LinkedWorkItemSummary | null
  initialBaseBranch?: string
  initialTab?: 'quick' | 'create-from'
}

const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
const tabShortcut = {
  quick: isMac ? '⌘N' : 'Ctrl+N',
  'create-from': isMac ? '⌘⇧N' : 'Ctrl+Shift+N'
} as const

function ShortcutHint({ children }: { children: React.ReactNode }): React.JSX.Element {
  // Why: a flat muted string reads as "secondary hint" rather than the
  // bordered kbd chip, which drew too much attention for a label most users
  // will learn once and forget. Stays inside the tab trigger so the hit
  // target covers it too.
  return (
    <span className="text-[10px] font-normal tracking-wide text-muted-foreground/70">
      {children}
    </span>
  )
}

export default function NewWorkspaceComposerModal(): React.JSX.Element | null {
  const visible = useAppStore((s) => s.activeModal === 'new-workspace-composer')
  const modalData = useAppStore((s) => s.modalData as ComposerModalData | undefined)
  const closeModal = useAppStore((s) => s.closeModal)

  // Why: Dialog open-state transitions must be driven by the store, not a
  // mirror useState, so palette/open-modal calls feel instantaneous and the
  // modal doesn't linger with stale data after close.
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closeModal()
      }
    },
    [closeModal]
  )

  if (!visible) {
    return null
  }

  return (
    <ComposerModalBody
      modalData={modalData ?? {}}
      onClose={closeModal}
      onOpenChange={handleOpenChange}
    />
  )
}

function ComposerModalBody({
  modalData,
  onClose,
  onOpenChange
}: {
  modalData: ComposerModalData
  onClose: () => void
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const activeTab = useAppStore((s) => s.newWorkspaceComposerTab)
  const setActiveTab = useAppStore((s) => s.setNewWorkspaceComposerTab)

  // Why: when the user starts something on Create-from that needs to fall
  // back to Quick (setup policy = 'ask', PR head resolution failed, ...) we
  // feed the prefill through this local override and remount the Quick
  // composer via a bumped key so its initial state absorbs the new data.
  // Without the key bump the useComposerState hook would keep its first
  // snapshot and the Quick tab would appear empty after fallback.
  const [prefillOverride, setPrefillOverride] = useState<ComposerModalData | null>(null)
  const [quickKey, setQuickKey] = useState(0)

  const effectiveQuickData = prefillOverride ?? modalData

  const handleFallbackToQuick = useCallback(
    (data: {
      initialRepoId?: string
      linkedWorkItem?: LinkedWorkItemSummary | null
      prefilledName?: string
      initialBaseBranch?: string
    }) => {
      setPrefillOverride({ ...data })
      setQuickKey((k) => k + 1)
      setActiveTab('quick')
    },
    [setActiveTab]
  )

  const handleCreateFromLaunched = useCallback(() => {
    onClose()
  }, [onClose])

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        // Why: pin a single width across both tabs. Create-from needs the
        // extra horizontal room for PR titles + branch names; Quick tolerates
        // it fine. Animating between widths was jarring and made the modal
        // feel unstable every time the user toggled tabs. The height cap
        // keeps the modal inside the viewport on short windows — without it
        // the 320px result list plus header/chrome can push the bottom
        // (including the Create button) below the fold.
        className="flex max-h-[85vh] flex-col sm:max-w-lg"
        onOpenAutoFocus={(event) => {
          // Why: Radix's FocusScope fires this once the dialog has mounted and
          // the DOM is ready. preventDefault stops it from focusing the first
          // tabbable in the Quick tab (the repo combobox trigger) when the
          // Create-from tab is active — that tab wants the search input to
          // own initial focus. The QuickTabBody handles its own focus below
          // when the Quick tab is active.
          if (activeTab === 'create-from') {
            return
          }
          event.preventDefault()
          const content = event.currentTarget as HTMLElement
          const trigger = content.querySelector<HTMLElement>(
            '[data-repo-combobox-root="true"][role="combobox"]'
          )
          trigger?.focus({ preventScroll: true })
        }}
      >
        <DialogHeader className="gap-1">
          <DialogTitle className="text-base font-semibold">Create Workspace</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {activeTab === 'quick'
              ? 'Pick a repository and agent to spin up a new workspace.'
              : 'Start from an existing PR, issue, branch, or Linear ticket.'}
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={activeTab}
          onValueChange={(next) => setActiveTab(next as 'quick' | 'create-from')}
          // Why: min-h-0 lets this flex child shrink below its intrinsic
          // content height so the modal's max-h-[85vh] cap can actually
          // engage on short viewports. Without it the tabs panel insists
          // on its content height and the modal grows past the cap.
          //
          // Both panels are force-mounted so switching tabs preserves their
          // local state (typed query on Create-from, repo pick / workspace
          // name on Quick) instead of remounting each time. The AnimatedTabPanels
          // wrapper animates the height delta between the two panels so the
          // modal gently resizes rather than popping.
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          {/* Why: use the shared underline variant so both levels of tabs
              read as "tabs" — the default pill variant fought the sub-tabs
              inside Create-from for visual weight. The bottom border on the
              list gives it clear separation from the content below. */}
          <TabsList
            variant="line"
            className="h-8 w-full justify-start gap-6 border-b border-border/60 px-0"
          >
            <TabsTrigger value="quick" className="flex-none gap-2 px-0 text-xs font-medium">
              Quick
              <ShortcutHint>{tabShortcut.quick}</ShortcutHint>
            </TabsTrigger>
            <TabsTrigger value="create-from" className="flex-none gap-2 px-0 text-xs font-medium">
              Create from…
              <ShortcutHint>{tabShortcut['create-from']}</ShortcutHint>
            </TabsTrigger>
          </TabsList>

          <AnimatedTabPanels active={activeTab}>
            {{
              quick: (
                <QuickTabBody
                  key={quickKey}
                  modalData={effectiveQuickData}
                  onClose={onClose}
                  active={activeTab === 'quick'}
                />
              ),
              'create-from': (
                <CreateFromTab
                  onLaunched={handleCreateFromLaunched}
                  onFallbackToQuick={handleFallbackToQuick}
                  active={activeTab === 'create-from'}
                />
              )
            }}
          </AnimatedTabPanels>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

function QuickTabBody({
  modalData,
  onClose,
  active
}: {
  modalData: ComposerModalData
  onClose: () => void
  active: boolean
}): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const { cardProps, composerRef, nameInputRef, submitQuick, createDisabled } = useComposerState({
    initialName: modalData.prefilledName ?? '',
    // Why: the modal is quick-create only now, so prompt-prefill state is
    // intentionally ignored even if older callers still send it.
    initialPrompt: '',
    initialLinkedWorkItem: modalData.linkedWorkItem ?? null,
    initialRepoId: modalData.initialRepoId,
    ...(modalData.initialBaseBranch ? { initialBaseBranch: modalData.initialBaseBranch } : {}),
    persistDraft: false,
    onCreated: onClose
  })
  // Why: the composer's built-in `onOpenAgentSettings` handler navigates to
  // the settings page and closes the modal. For the quick-create flow we want
  // a less disruptive affordance — a nested dialog layered over the composer
  // so the user can tweak agents without losing their in-progress workspace
  // name/repo selection.
  const [agentSettingsOpen, setAgentSettingsOpen] = useState(false)
  // Why: once the user picks an agent, their choice wins and must not be
  // overwritten when the derived "preferred" value changes (e.g. detection
  // finishes and adds more installed agents to the set). Track that with an
  // override rather than an effect that mirrors a prop into state — deriving
  // during render keeps the selection in sync with the detected set without
  // triggering an extra commit.
  const [quickAgentOverride, setQuickAgentOverride] = useState<TuiAgent | null | undefined>(
    undefined
  )
  const preferredQuickAgent = useMemo<TuiAgent | null>(() => {
    const pref = settings?.defaultTuiAgent
    if (pref === 'blank') {
      // Why: 'blank' is the explicit "no agent" preference — the quick agent
      // model already uses null to mean "blank terminal", so translate here.
      return null
    }
    if (pref) {
      return pref
    }
    const detected = cardProps.detectedAgentIds
    return AGENT_CATALOG.find((agent) => detected === null || detected.has(agent.id))?.id ?? null
  }, [cardProps.detectedAgentIds, settings?.defaultTuiAgent])
  const quickAgent = quickAgentOverride === undefined ? preferredQuickAgent : quickAgentOverride

  const handleQuickAgentChange = useCallback((agent: TuiAgent | null) => {
    setQuickAgentOverride(agent)
  }, [])

  const handleCreate = useCallback(async (): Promise<void> => {
    await submitQuick(quickAgent)
  }, [quickAgent, submitQuick])

  // Cmd/Ctrl+Enter submits, Esc first blurs the focused input (like the full page).
  useEffect(() => {
    if (!active) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' && event.key !== 'Escape') {
        return
      }
      const target = event.target
      if (!(target instanceof HTMLElement)) {
        return
      }

      if (event.key === 'Escape') {
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
        onClose()
        return
      }

      // Why: require the platform modifier (Cmd on macOS, Ctrl elsewhere) so
      // plain Enter inside fields (notes, repo search) doesn't accidentally
      // submit — users can type or confirm selections without triggering
      // workspace creation.
      const hasModifier = event.metaKey || event.ctrlKey
      if (!hasModifier) {
        return
      }
      if (!composerRef.current?.contains(target)) {
        return
      }
      if (createDisabled) {
        return
      }
      if (shouldSuppressEnterSubmit(event, false)) {
        return
      }
      event.preventDefault()
      void handleCreate()
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [active, composerRef, createDisabled, handleCreate, onClose])

  // Why: when the Quick tab becomes active (initial mount, or switched to
  // from Create-from), focus the repo combobox trigger so the confirmed
  // selection sits ready and the keyboard flow starts at the top of the
  // form — matching Dialog's onOpenAutoFocus behavior in the pre-tabs modal.
  useEffect(() => {
    if (!active) {
      return
    }
    const root = composerRef.current
    if (!root) {
      return
    }
    const trigger = root.querySelector<HTMLElement>(
      '[data-repo-combobox-root="true"][role="combobox"]'
    )
    trigger?.focus({ preventScroll: true })
  }, [active, composerRef])

  return (
    <>
      <NewWorkspaceComposerCard
        composerRef={composerRef}
        nameInputRef={nameInputRef}
        quickAgent={quickAgent}
        onQuickAgentChange={handleQuickAgentChange}
        {...cardProps}
        onOpenAgentSettings={() => setAgentSettingsOpen(true)}
        onCreate={() => void handleCreate()}
      />
      <AgentSettingsDialog open={agentSettingsOpen} onOpenChange={setAgentSettingsOpen} />
    </>
  )
}

type TabKey = 'quick' | 'create-from'

/**
 * Keeps both tab panels mounted so their local state survives a tab swap,
 * and animates the container's height to the active panel's intrinsic
 * height so the modal resizes smoothly instead of popping.
 *
 * Both panels are absolutely positioned so the wrapper is free to animate
 * its own height between their intrinsic sizes. We measure each panel's
 * natural height via an inner wrapper (ref-captured) whose size doesn't
 * depend on the outer wrapper's height. ResizeObserver keeps the
 * measurement fresh when content inside a panel changes (Advanced drawer
 * expanding, search results filling in).
 */
function AnimatedTabPanels({
  active,
  children
}: {
  active: TabKey
  children: Record<TabKey, React.ReactNode>
}): React.JSX.Element {
  const quickInnerRef = useRef<HTMLDivElement | null>(null)
  const createFromInnerRef = useRef<HTMLDivElement | null>(null)
  const [quickH, setQuickH] = useState<number | null>(null)
  const [createFromH, setCreateFromH] = useState<number | null>(null)

  useLayoutEffect(() => {
    const observe = (
      el: HTMLElement | null,
      setter: (n: number) => void
    ): (() => void) | undefined => {
      if (!el) {
        return undefined
      }
      const update = (): void => {
        const next = el.getBoundingClientRect().height
        if (next > 0) {
          setter(next)
        }
      }
      update()
      const observer = new ResizeObserver(update)
      observer.observe(el)
      return () => observer.disconnect()
    }
    const cleanupQuick = observe(quickInnerRef.current, setQuickH)
    const cleanupCf = observe(createFromInnerRef.current, setCreateFromH)
    return () => {
      cleanupQuick?.()
      cleanupCf?.()
    }
  }, [])

  const targetHeight = active === 'quick' ? quickH : createFromH

  return (
    <div
      className="relative min-h-0 overflow-hidden transition-[height] duration-200 ease-out"
      style={{
        // Why: fall back to `auto` before the first measurement lands so
        // the wrapper doesn't paint at 0px on initial render. Once a real
        // height is known, drive it explicitly so the CSS transition can
        // animate the change on tab swap.
        height: targetHeight !== null ? targetHeight : 'auto'
      }}
    >
      <div
        className={cn(
          'absolute inset-x-0 top-0 transition-opacity duration-150 ease-out',
          active === 'quick'
            ? 'pointer-events-auto opacity-100'
            : 'pointer-events-none invisible opacity-0'
        )}
        aria-hidden={active !== 'quick'}
      >
        <div ref={quickInnerRef} className="pt-4">
          {children.quick}
        </div>
      </div>
      <div
        className={cn(
          'absolute inset-x-0 top-0 transition-opacity duration-150 ease-out',
          active === 'create-from'
            ? 'pointer-events-auto opacity-100'
            : 'pointer-events-none invisible opacity-0'
        )}
        aria-hidden={active !== 'create-from'}
      >
        <div ref={createFromInnerRef} className="pt-3">
          {children['create-from']}
        </div>
      </div>
    </div>
  )
}
