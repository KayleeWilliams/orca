import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../store'
import { findBundledPetModel, PET_MODELS } from './pet-models'
import { blobUrlCache, loadCustomBlobUrl } from './pet-blob-cache'

// Re-export so existing callers (the store slice) that point at this module
// keep working without knowing about the cache module split.
export { revokeCustomPetBlobUrl } from './pet-blob-cache'

/** Resolve the active pet model to a URL the overlay can render.
 *
 *  For bundled models (always GLB) this is synchronous. For custom models we
 *  issue an IPC read and build a blob: URL with the correct MIME; until that
 *  resolves, we fall back to the default bundled GLB so the overlay is never
 *  empty. `kind` tells the overlay whether to render 3D (three.js) or 2D
 *  (<img>).
 */
export function usePetModelUrl(): { url: string; ready: boolean; kind: 'glb' | 'image' } {
  const petModelId = useAppStore((s) => s.petModelId)
  const customModels = useAppStore((s) => s.customPetModels)
  const bundled = findBundledPetModel(petModelId)
  const customMeta = bundled ? null : customModels.find((m) => m.id === petModelId)

  const [customUrl, setCustomUrl] = useState<string | null>(() =>
    customMeta ? (blobUrlCache.get(customMeta.id) ?? null) : null
  )
  // Why: track the last id we started loading so a rapid switch between
  // custom models doesn't let a slower earlier response clobber the newer
  // state.
  const pendingRef = useRef<string | null>(null)

  const customId = customMeta?.id ?? null
  // Why: back-compat — models imported before image support lack both fields;
  // treat them as GLB (the only kind that existed then) with the standard
  // glTF MIME so existing users don't have to re-import.
  const customMime = customMeta?.mimeType ?? 'model/gltf-binary'
  useEffect(() => {
    if (!customId) {
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
    // Otherwise a switch between two uncached customs would render the new
    // customMeta.kind alongside the old customUrl — e.g. a GLB URL handed to
    // the <img> branch — until the read IPC returns.
    setCustomUrl(null)
    pendingRef.current = customId
    let cancelled = false
    void loadCustomBlobUrl(customId, customMime).then((url) => {
      if (cancelled || pendingRef.current !== customId) {
        return
      }
      setCustomUrl(url)
    })
    return () => {
      cancelled = true
    }
  }, [customId, customMime])

  if (bundled) {
    return { url: bundled.url, ready: true, kind: 'glb' }
  }
  if (customMeta && customUrl) {
    return { url: customUrl, ready: true, kind: customMeta.kind ?? 'glb' }
  }
  // Fallback: while a custom blob URL is loading (or if the custom model is
  // missing entirely), render the default bundled GLB so the overlay
  // doesn't flash empty.
  return { url: PET_MODELS[0].url, ready: false, kind: 'glb' }
}
