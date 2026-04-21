import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import NewWorkspaceComposerCard from '@/components/NewWorkspaceComposerCard'
import { useComposerState } from '@/hooks/useComposerState'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { shouldSuppressEnterSubmit } from '@/lib/new-workspace-enter-guard'
import type { TuiAgent } from '../../../shared/types'

type ComposerModalData = {
  prefilledName?: string
  initialRepoId?: string
  linkedWorkItem?: LinkedWorkItemSummary | null
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
  const settings = useAppStore((s) => s.settings)
  const { cardProps, composerRef, nameInputRef, submitQuick, createDisabled } = useComposerState({
    initialName: modalData.prefilledName ?? '',
    // Why: the modal is quick-create only now, so prompt-prefill state is
    // intentionally ignored even if older callers still send it.
    initialPrompt: '',
    initialLinkedWorkItem: modalData.linkedWorkItem ?? null,
    initialRepoId: modalData.initialRepoId,
    persistDraft: false,
    onCreated: onClose
  })
  const [quickAgentTouched, setQuickAgentTouched] = useState(false)
  const preferredQuickAgent = useMemo<TuiAgent | null>(() => {
    if (settings?.defaultTuiAgent) {
      return settings.defaultTuiAgent
    }
    const detected = cardProps.detectedAgentIds
    return AGENT_CATALOG.find((agent) => detected === null || detected.has(agent.id))?.id ?? null
  }, [cardProps.detectedAgentIds, settings?.defaultTuiAgent])
  const [quickAgent, setQuickAgent] = useState<TuiAgent | null>(preferredQuickAgent)

  useEffect(() => {
    if (!quickAgentTouched) {
      setQuickAgent(preferredQuickAgent)
    }
  }, [preferredQuickAgent, quickAgentTouched])

  const handleQuickAgentChange = useCallback((agent: TuiAgent | null) => {
    setQuickAgentTouched(true)
    setQuickAgent(agent)
  }, [])

  const handleCreate = useCallback(async (): Promise<void> => {
    await submitQuick(quickAgent)
  }, [quickAgent, submitQuick])

  // Cmd/Ctrl+Enter submits, Esc first blurs the focused input (like the full page).
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
  }, [composerRef, createDisabled, handleCreate, onClose])

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        onOpenAutoFocus={(event) => {
          // Why: Radix's FocusScope fires this once the dialog has mounted and
          // the DOM is ready. preventDefault stops it from focusing the first
          // tabbable (which would otherwise steal focus to whatever ships
          // first in markup); we then focus the repo combobox trigger so the
          // guessed value sits as a confirmed selection without opening its
          // popover — matching the "default = selection, typing = search"
          // combobox pattern. Doing it here (instead of a child rAF) avoids
          // Strict-Mode effect double-invocation dropping the focus call.
          event.preventDefault()
          const content = event.currentTarget as HTMLElement
          const trigger = content.querySelector<HTMLElement>(
            '[data-repo-combobox-root="true"][role="combobox"]'
          )
          trigger?.focus({ preventScroll: true })
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">Create Workspace</DialogTitle>
          <DialogDescription className="text-xs">
            Pick a repository and agent to spin up a new workspace.
          </DialogDescription>
        </DialogHeader>
        <NewWorkspaceComposerCard
          composerRef={composerRef}
          nameInputRef={nameInputRef}
          quickAgent={quickAgent}
          onQuickAgentChange={handleQuickAgentChange}
          {...cardProps}
          onCreate={() => void handleCreate()}
        />
      </DialogContent>
    </Dialog>
  )
}
