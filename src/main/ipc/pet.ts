import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, extname, join, normalize, sep } from 'node:path'
import type { CustomPetKind, CustomPetModel } from '../../shared/types'

// Why: map from extension → (kind, mime). Images are static + animated variants
// rendered by <img>; GLB goes through three.js. Keeping this table here so the
// main process is the single source of truth for which formats are accepted.
const IMAGE_FORMATS: Record<string, string> = {
  '.png': 'image/png',
  '.apng': 'image/apng',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
}

function classifyFile(src: string): { kind: CustomPetKind; mimeType: string } | null {
  const ext = extname(src).toLowerCase()
  if (ext === '.glb') {
    return { kind: 'glb', mimeType: 'model/gltf-binary' }
  }
  const mime = IMAGE_FORMATS[ext]
  if (mime) {
    return { kind: 'image', mimeType: mime }
  }
  return null
}

// Why: custom user-uploaded GLBs live in a dedicated folder under userData so
// they persist across app updates but are scoped to the Orca install. We never
// trust paths the renderer hands us — the renderer only ever knows the opaque
// CustomPetModel.id; main resolves it to an absolute path inside this folder.
function getPetsDir(): string {
  return join(app.getPath('userData'), 'pets', 'custom')
}

const MAX_GLB_BYTES = 256 * 1024 * 1024 // 256 MB — generous cap; still bounded so a user can't point at a multi-GB file and OOM the renderer when it builds a Blob URL.

function isSafeId(id: string): boolean {
  // UUIDs only; blocks path traversal and unexpected characters.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}

function resolvePetFile(id: string): string | null {
  if (!isSafeId(id)) {
    return null
  }
  // Why: normalize() + prefix check defends against any edge case where the id
  // slipped the regex. The file is always `<id>.glb` inside the pets dir.
  const filePath = normalize(join(getPetsDir(), `${id}.glb`))
  if (!filePath.startsWith(normalize(getPetsDir()) + sep)) {
    return null
  }
  return filePath
}

export function registerPetHandlers(): void {
  ipcMain.handle('pet:import', async (event): Promise<CustomPetModel | null> => {
    // Why: parent the file picker to the sender window. Without a parent, on
    // macOS the dialog opens as an app-level sheet that can land behind the
    // main window (appears as "nothing happened" when the user clicks
    // Upload GLB…). fromWebContents is the reliable way to resolve the
    // sender — focused window isn't, because DropdownMenu's modal layer can
    // momentarily steal focus before the handler runs.
    const senderWindow =
      BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a pet',
      properties: ['openFile'],
      // Why: single filter and no `apng` extension. macOS file dialogs map
      // filter extensions to UTIs; `apng` has no registered UTI, so including
      // it can cause macOS to drop sibling extensions (notably `webp`) from
      // the allowed set — users saw `.webp` files greyed out even though the
      // filter list declared them. APNG files carry the `.png` extension and
      // are detected from magic bytes by the renderer, so dropping the
      // `apng` extension here costs nothing. Multiple filters also surface a
      // macOS dropdown whose last selection persists per-app; collapsing to
      // one filter removes that footgun.
      filters: [
        {
          name: 'Pet (GLB or image)',
          extensions: ['glb', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']
        }
      ]
    }
    const result = senderWindow
      ? await dialog.showOpenDialog(senderWindow, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    const src = result.filePaths[0]
    // Why: classify before stat so a wrong-format file shows a clean error
    // rather than "too large". Each supported format maps to its MIME so the
    // renderer can build a correct Blob (SVG won't render with the wrong
    // Content-Type, and GLBs load faster when three.js sees the right MIME).
    const classified = classifyFile(src)
    if (!classified) {
      throw new Error('Unsupported file. Pick a GLB (3D) or PNG / APNG / JPG / GIF / WebP / SVG.')
    }
    let srcStat: Awaited<ReturnType<typeof stat>>
    try {
      srcStat = await stat(src)
    } catch {
      // Why: surface a user-facing message instead of leaking ENOENT/EACCES.
      throw new Error('Could not read the selected file.')
    }
    if (!srcStat.isFile()) {
      throw new Error('Selected path is not a file')
    }
    if (srcStat.size > MAX_GLB_BYTES) {
      // Why: unbounded reads would let a user point at a multi-GB file and
      // effectively DoS the renderer when it tries to build a Blob URL.
      throw new Error(
        `File is too large (${(srcStat.size / (1024 * 1024)).toFixed(1)} MB). Max is ${MAX_GLB_BYTES / (1024 * 1024)} MB.`
      )
    }

    const dir = getPetsDir()
    await mkdir(dir, { recursive: true })
    const id = randomUUID()
    // Why: filename extension is purely a storage convention — pet:read
    // returns raw bytes and the renderer uses CustomPetModel.mimeType to
    // build the Blob. Keeping the on-disk name as `<id>.glb` regardless of
    // kind means resolvePetFile stays ext-free and legacy installs keep
    // working without a migration. The real format lives in CustomPetModel.
    const dest = join(dir, `${id}.glb`)
    try {
      await copyFile(src, dest)
    } catch {
      // Why: clean up partial copy so a later list/read doesn't surface a
      // half-written file that would fail to parse in the renderer.
      await rm(dest, { force: true }).catch(() => {})
      throw new Error('Could not save the pet.')
    }

    const rawLabel = basename(src, extname(src)).trim()
    const label = rawLabel.length > 0 ? rawLabel.slice(0, 40) : 'Custom pet'
    return {
      id,
      label,
      fileName: `${id}.glb`,
      kind: classified.kind,
      mimeType: classified.mimeType
    }
  })

  ipcMain.handle('pet:read', async (_event, id: string): Promise<ArrayBuffer | null> => {
    const filePath = resolvePetFile(id)
    if (!filePath) {
      return null
    }
    try {
      const buf = await readFile(filePath)
      // Why: return as ArrayBuffer so the renderer can build a Blob + objectURL
      // directly. File-protocol hand-off is blocked by webSecurity=true and
      // sandbox=true, and we don't want to weaken either for this one feature.
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    } catch (error) {
      // Why: log for diagnostics — silent null made it indistinguishable
      // from "not found" vs real fs failures during renderer debugging.
      console.warn('[pet-overlay] pet:read failed', error)
      return null
    }
  })

  ipcMain.handle('pet:delete', async (_event, id: string): Promise<void> => {
    const filePath = resolvePetFile(id)
    if (!filePath) {
      return
    }
    try {
      await rm(filePath, { force: true })
    } catch (error) {
      // Why: swallowing EACCES silently would leave a ghost file that still
      // appears in listings; log so we can see it in diagnostics.
      console.warn('[pet-overlay] pet:delete failed', error)
    }
  })
}
