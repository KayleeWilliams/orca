import React from 'react'
import { Cat, Check, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '../../store'
import { findBundledPetModel, PET_MODELS } from '../pet/pet-models'

// Why: cluster pet-related controls (show/hide, model picker, custom GLB
// upload + removal, jump-to-settings) behind a single status-bar segment.
// Only rendered when experimentalPet is on (gated by the caller). Pet
// visibility is independently tracked so users can dismiss without having to
// find the experimental flag again.
function PetStatusSegmentInner({
  compact,
  iconOnly
}: {
  compact: boolean
  iconOnly: boolean
}): React.JSX.Element {
  const petVisible = useAppStore((s) => s.petVisible)
  const setPetVisible = useAppStore((s) => s.setPetVisible)
  const petModelId = useAppStore((s) => s.petModelId)
  const setPetModelId = useAppStore((s) => s.setPetModelId)
  const customPetModels = useAppStore((s) => s.customPetModels)
  const addCustomPetModel = useAppStore((s) => s.addCustomPetModel)
  const removeCustomPetModel = useAppStore((s) => s.removeCustomPetModel)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)

  const bundled = findBundledPetModel(petModelId)
  const activeCustom = bundled ? null : customPetModels.find((m) => m.id === petModelId)
  const activeLabel = bundled?.label ?? activeCustom?.label ?? 'Pet'
  const label = petVisible ? activeLabel : `${activeLabel} hidden`

  const handleImport = async (): Promise<void> => {
    // Why: surface end-to-end diagnostics under a stable prefix so clicks on
    // Upload GLB… that appear to do nothing (preload not reloaded, IPC not
    // registered, dialog dismissed) leave a greppable trail in the console.
    console.log('[pet-overlay] upload: click')
    if (!window.api?.pet?.importModel) {
      console.warn('[pet-overlay] upload: window.api.pet.importModel missing — restart Orca')
      toast.error('Custom pet upload needs a full app restart (not just reload).')
      return
    }
    try {
      const model = await window.api.pet.importModel()
      console.log('[pet-overlay] upload: result', model)
      if (!model) {
        return
      }
      addCustomPetModel(model)
      if (!petVisible) {
        setPetVisible(true)
      }
      setPetModelId(model.id)
      toast.success(`Added "${model.label}"`)
    } catch (error) {
      console.error('[pet-overlay] upload: error', error)
      toast.error(error instanceof Error ? error.message : 'Failed to import file')
    }
  }

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center cursor-pointer gap-1 rounded px-1 py-0.5 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
              aria-label="Pet menu"
            >
              <Cat className={`size-3.5 ${petVisible ? '' : 'opacity-50'}`} aria-hidden />
              {!iconOnly && !compact ? (
                <span className="text-[11px] font-medium">{label}</span>
              ) : null}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          {petVisible ? `${activeLabel} (pet)` : `${activeLabel} hidden — click to restore`}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="top" align="end" sideOffset={8} className="min-w-[220px]">
        <DropdownMenuLabel>Pet</DropdownMenuLabel>
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault()
            setPetVisible(!petVisible)
          }}
        >
          {petVisible ? 'Hide pet' : 'Show pet'}
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Model</DropdownMenuSubTrigger>
          {/* Why: portal so the submenu escapes the parent Content's overflow
              clipping — without this, the submenu opens inside the scroll
              container and gets clipped. Explicit portal matches the existing
              convention used in BrowserToolbarMenu/BrowserProfileRow. */}
          <DropdownMenuPortal>
            <DropdownMenuSubContent className="min-w-[220px]">
              {PET_MODELS.map((model) => {
                const selected = model.id === petModelId
                return (
                  <DropdownMenuItem
                    key={model.id}
                    onSelect={(event) => {
                      event.preventDefault()
                      if (!petVisible) {
                        setPetVisible(true)
                      }
                      setPetModelId(model.id)
                    }}
                  >
                    <span className="flex w-4 items-center justify-center">
                      {selected ? <Check className="size-3.5" aria-hidden /> : null}
                    </span>
                    {model.label}
                  </DropdownMenuItem>
                )
              })}
              {customPetModels.length > 0 ? <DropdownMenuSeparator /> : null}
              {customPetModels.map((model) => {
                const selected = model.id === petModelId
                return (
                  <DropdownMenuItem
                    key={model.id}
                    className="group"
                    onSelect={(event) => {
                      event.preventDefault()
                      if (!petVisible) {
                        setPetVisible(true)
                      }
                      setPetModelId(model.id)
                    }}
                  >
                    <span className="flex w-4 items-center justify-center">
                      {selected ? <Check className="size-3.5" aria-hidden /> : null}
                    </span>
                    <span className="flex-1 truncate">{model.label}</span>
                    {/* Why: inline remove — a native button sits inside the menu
                      item so the destructive action is discoverable without
                      another menu level. stopPropagation prevents Radix from
                      also triggering the item's onSelect. */}
                    <button
                      type="button"
                      className="ml-2 flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                      aria-label={`Remove ${model.label}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        event.preventDefault()
                        removeCustomPetModel(model.id)
                        toast.success(`Removed "${model.label}"`)
                      }}
                    >
                      <Trash2 className="size-3" aria-hidden />
                    </button>
                  </DropdownMenuItem>
                )
              })}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  // Why: let the menu close naturally (no preventDefault) before
                  // invoking the native file picker. Keeping the menu open when
                  // the OS dialog opens caused the dialog to appear behind the
                  // dropdown overlay on macOS — clicks on "Upload GLB…" looked
                  // like nothing happened.
                  void handleImport()
                }}
              >
                <Upload className="size-3.5" aria-hidden />
                Upload GLB or image…
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            openSettingsTarget({
              pane: 'experimental',
              repoId: null,
              sectionId: 'experimental-pet'
            })
            openSettingsPage()
          }}
        >
          Pet settings…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export const PetStatusSegment = React.memo(PetStatusSegmentInner)
