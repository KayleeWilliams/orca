import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../store'
import { BUNDLED_PET, findBundledPet, isBundledPetId } from './pet-models'
import { blobUrlCache, loadCustomBlobUrl } from './pet-blob-cache'

// Re-export so existing callers (the store slice) that point at this module
// keep working without knowing about the cache module split.
export { revokeCustomPetBlobUrl } from './pet-blob-cache'

/** Resolve the active pet to a URL the overlay can render.
 *
 *  For the bundled default this is synchronous. For custom models we issue an
 *  IPC read and build a blob: URL with the correct MIME; until that resolves,
 *  we fall back to the bundled default so the overlay is never empty.
 */
export function usePetModelUrl(): { url: string; ready: boolean } {
  const petModelId = useAppStore((s) => s.petModelId)
  const customModels = useAppStore((s) => s.customPetModels)
  const bundled = isBundledPetId(petModelId)
  const customMeta = bundled ? null : customModels.find((m) => m.id === petModelId)

  const [customUrl, setCustomUrl] = useState<string | null>(() =>
    customMeta ? (blobUrlCache.get(customMeta.id) ?? null) : null
  )
  // Why: track the last id we started loading so a rapid switch between
  // custom models doesn't let a slower earlier response clobber the newer
  // state.
  const pendingRef = useRef<string | null>(null)

  const customId = customMeta?.id ?? null
  const customFileName = customMeta?.fileName ?? null
  const customMime = customMeta?.mimeType ?? 'image/png'
  useEffect(() => {
    if (!customId || !customFileName) {
      setCustomUrl(null)
      return
    }
    const cached = blobUrlCache.get(customId)
    if (cached) {
      setCustomUrl(cached)
      return
    }
    // Why: clear the previous custom blob URL before awaiting the new one so
    // the hook's fallback-to-bundled branch kicks in during the load window.
    setCustomUrl(null)
    pendingRef.current = customId
    let cancelled = false
    void loadCustomBlobUrl(customId, customFileName, customMime).then((url) => {
      if (cancelled || pendingRef.current !== customId) {
        return
      }
      setCustomUrl(url)
    })
    return () => {
      cancelled = true
    }
  }, [customId, customFileName, customMime])

  if (bundled) {
    const pet = findBundledPet(petModelId) ?? BUNDLED_PET
    return { url: pet.url, ready: true }
  }
  if (customMeta && customUrl) {
    return { url: customUrl, ready: true }
  }
  // Fallback: while a custom blob URL is loading (or if the custom model is
  // missing entirely), render the bundled default so the overlay doesn't
  // flash empty.
  return { url: BUNDLED_PET.url, ready: false }
}
