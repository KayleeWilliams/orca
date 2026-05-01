// Why: bundled GLB URLs are Vite ?url asset imports so the renderer's asset
// pipeline hashes them at build time — same approach as the original single-
// model PetScene. Keeping them behind a single registry lets PetScene,
// PetOverlay, and the status-bar picker all agree on the available set without
// drifting.
import demonUrl from '../../../../../resources/pets/demon.glb?url'
import dinosaurUrl from '../../../../../resources/pets/dinosaur.glb?url'
import pottedPlantUrl from '../../../../../resources/pets/potted-plant.glb?url'
import slothUrl from '../../../../../resources/pets/sloth.glb?url'

export type PetModelId = 'gremlin' | 'dinosaur' | 'potted-plant' | 'sloth'

export type PetModel = {
  id: PetModelId
  label: string
  url: string
}

// Why: declare the registry as a readonly tuple keyed on PetModelId so TS
// catches any id/url drift at compile time and so consumers can iterate for
// menus without a separate source of truth.
export const PET_MODELS: readonly PetModel[] = [
  { id: 'gremlin', label: 'Gremlin', url: demonUrl },
  { id: 'dinosaur', label: 'Dinosaur', url: dinosaurUrl },
  { id: 'potted-plant', label: 'Potted plant', url: pottedPlantUrl },
  { id: 'sloth', label: 'Sloth', url: slothUrl }
] as const

export const DEFAULT_PET_MODEL_ID: PetModelId = 'gremlin'

/** Resolves a bundled pet model by id. For custom models (arbitrary UUID
 *  strings), returns null — the caller should fall back to the custom-model
 *  list on the ui slice. */
export function findBundledPetModel(id: string | undefined): PetModel | null {
  return PET_MODELS.find((m) => m.id === id) ?? null
}

/** Back-compat: any call site that needs a guaranteed bundled PetModel (e.g.
 *  the overlay during initial render before a custom blob URL resolves) can
 *  use this. Unknown ids fall back to the default bundled gremlin. */
export function resolvePetModel(id: string | undefined): PetModel {
  return findBundledPetModel(id) ?? PET_MODELS[0]
}
