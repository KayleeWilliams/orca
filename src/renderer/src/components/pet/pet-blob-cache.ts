// Why: isolated module so the store slice can call revokeCustomPetBlobUrl
// without importing usePetModelUrl (which itself imports the store). Keeps
// the dependency graph acyclic.

// Why: sandbox=true + webSecurity=true block the renderer from reading user
// files directly. For custom pet models we fetch the bytes over IPC and turn
// them into a `blob:` URL that three.js can load like any other GLB. A small
// in-memory cache means switching back and forth between models in the same
// session doesn't re-fetch from main.
export const blobUrlCache = new Map<string, string>()

export async function loadCustomBlobUrl(
  id: string,
  mimeType: string = 'model/gltf-binary'
): Promise<string | null> {
  const cached = blobUrlCache.get(id)
  if (cached) {
    return cached
  }
  const buffer = await window.api.pet.readModel(id)
  if (!buffer) {
    return null
  }
  // Why: MIME comes from CustomPetModel.mimeType — required for images
  // (especially SVG, which browsers refuse to render from a blob URL with
  // the wrong Content-Type). GLB bytes work either way but we pass the
  // right one for correctness.
  const blob = new Blob([buffer], { type: mimeType })
  const url = URL.createObjectURL(blob)
  blobUrlCache.set(id, url)
  return url
}

// Why: the store invokes this on removeCustomPetModel so the underlying Blob
// is released; otherwise the blob: URL keeps it alive for the rest of the
// session, wasting megabytes per imported model.
export function revokeCustomPetBlobUrl(id: string): void {
  const url = blobUrlCache.get(id)
  if (url) {
    URL.revokeObjectURL(url)
    blobUrlCache.delete(id)
  }
}
