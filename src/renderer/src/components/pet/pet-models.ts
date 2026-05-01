import theClaudeUrl from '../../../../../resources/claude.webp?url'
import theOpencodeUrl from '../../../../../resources/opencode.webp?url'
import theGremlinUrl from '../../../../../resources/gremlin.webp?url'

// Why: bundled defaults so the overlay always has something to render when the
// user hasn't uploaded a custom image. Vite's `?url` import hashes each asset
// at build time so they participate in the normal caching pipeline.
export const DEFAULT_PET_MODEL_ID = 'default'
export const OPENCODE_PET_MODEL_ID = 'the-opencode'
export const GREMLIN_PET_MODEL_ID = 'the-gremlin'

export type BundledPetModelId =
  | typeof DEFAULT_PET_MODEL_ID
  | typeof OPENCODE_PET_MODEL_ID
  | typeof GREMLIN_PET_MODEL_ID

export type BundledPetModel = {
  id: BundledPetModelId
  label: string
  url: string
}

export const BUNDLED_PETS: readonly BundledPetModel[] = [
  {
    id: DEFAULT_PET_MODEL_ID,
    label: 'The Claude',
    url: theClaudeUrl
  },
  {
    id: OPENCODE_PET_MODEL_ID,
    label: 'The OpenCode',
    url: theOpencodeUrl
  },
  {
    id: GREMLIN_PET_MODEL_ID,
    label: 'The Gremlin',
    url: theGremlinUrl
  }
] as const

// Why: keep the single-pet export around so existing call sites that refer to
// "the" bundled pet (fallback URL while loading, default selection) continue
// to resolve to the original Claude image.
export const BUNDLED_PET: BundledPetModel = BUNDLED_PETS[0]

export function isBundledPetId(id: string | undefined): boolean {
  return BUNDLED_PETS.some((p) => p.id === id)
}

export function findBundledPet(id: string | undefined): BundledPetModel | undefined {
  return BUNDLED_PETS.find((p) => p.id === id)
}
