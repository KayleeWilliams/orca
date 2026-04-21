import {
  ChevronDown,
  ChevronUp,
  Image as ImageIcon,
  RotateCcw,
  Search,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

const FALLBACK_IMAGE_MIME_TYPE = 'image/png'
const MIN_ZOOM = 0.25
const MAX_ZOOM = 8
const ZOOM_STEP = 1.25

type ImageViewerProps = {
  content: string
  filePath: string
  mimeType?: string
}

export default function ImageViewer({
  content,
  filePath,
  mimeType = FALLBACK_IMAGE_MIME_TYPE
}: ImageViewerProps): JSX.Element {
  const [imageError, setImageError] = useState(false)
  const [isPopupOpen, setIsPopupOpen] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(
    null
  )

  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [activeMatch, setActiveMatch] = useState(0)
  const [totalMatches, setTotalMatches] = useState(0)
  const findInputRef = useRef<HTMLInputElement>(null)

  const filename = useMemo(() => filePath.split(/[/\\]/).pop() || filePath, [filePath])
  const cleanedContent = useMemo(() => content.replace(/\s/g, ''), [content])
  const isPdf = mimeType === 'application/pdf'
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const estimatedSize = useMemo(() => {
    const bytes = Math.floor((cleanedContent.length * 3) / 4)
    if (bytes < 1024) {
      return `${bytes} B`
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }, [cleanedContent])
  const zoomPercent = Math.round(zoom * 100)

  useEffect(() => {
    setImageError(false)

    if (!cleanedContent) {
      setPreviewUrl(null)
      return
    }

    // Why: window.atob() throws a DOMException if cleanedContent contains
    // invalid base64 characters (e.g. corrupt or truncated data). We catch
    // that so the component degrades to the error state instead of crashing.
    let binary: string
    try {
      binary = window.atob(cleanedContent)
    } catch {
      setImageError(true)
      return
    }

    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i)
    }

    // Why: large binary previews behave better as object URLs than giant
    // inline data URLs. PDFs especially can surface awkward native viewer UI
    // when loaded from a data URL, and object URLs avoid keeping megabytes of
    // base64 text in the DOM.
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }))
    setPreviewUrl(objectUrl)

    return () => URL.revokeObjectURL(objectUrl)
  }, [cleanedContent, mimeType])

  // ── PDF find-in-page via main-window webContents IPC ──────────────
  // Why: the <embed> PDF viewer is a Chromium plugin whose DOM is in a
  // separate process. The BrowserWindow's webContents.findInPage() can
  // search the Chromium PDF viewer's text layer at the compositor level,
  // so we route find requests through IPC to the main process.

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(findQuery), 200)
    return () => clearTimeout(id)
  }, [findQuery])

  useEffect(() => {
    if (!findOpen) {
      window.api.ui.rendererStopFindInPage('clearSelection')
      setActiveMatch(0)
      setTotalMatches(0)
      return
    }
    findInputRef.current?.focus()
    findInputRef.current?.select()
  }, [findOpen])

  useEffect(() => {
    if (!debouncedQuery || !findOpen) {
      if (findOpen) {
        window.api.ui.rendererStopFindInPage('clearSelection')
      }
      setActiveMatch(0)
      setTotalMatches(0)
      return
    }
    window.api.ui.rendererFindInPage(debouncedQuery)
  }, [debouncedQuery, findOpen])

  useEffect(() => {
    if (!findOpen) {
      return
    }
    return window.api.ui.onRendererFoundInPage((result) => {
      setActiveMatch(result.activeMatchOrdinal)
      setTotalMatches(result.matches)
    })
  }, [findOpen])

  const findNext = useCallback(() => {
    if (findQuery) {
      window.api.ui.rendererFindInPage(findQuery, { forward: true, findNext: true })
    }
  }, [findQuery])

  const findPrevious = useCallback(() => {
    if (findQuery) {
      window.api.ui.rendererFindInPage(findQuery, { forward: false, findNext: true })
    }
  }, [findQuery])

  const closeFindBar = useCallback(() => {
    setFindOpen(false)
  }, [])

  // Why: when the <embed> PDF plugin has focus, keyboard events go to the
  // plugin process and don't propagate to the renderer's DOM. This handler
  // only fires when focus is outside the embed (e.g. right after tab switch).
  // The Search button in the toolbar is the reliable entry point.
  useEffect(() => {
    if (!isPdf) {
      return
    }
    const handleKeyDown = (e: KeyboardEvent): void => {
      const isMod = navigator.userAgent.includes('Mac') ? e.metaKey : e.ctrlKey
      if (isMod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        e.stopPropagation()
        setFindOpen(true)
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [isPdf])

  const handleFindKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        closeFindBar()
      } else if (e.key === 'Enter' && e.shiftKey) {
        findPrevious()
      } else if (e.key === 'Enter') {
        findNext()
      }
    },
    [closeFindBar, findNext, findPrevious]
  )

  if (imageError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-muted/20 p-8 text-sm text-muted-foreground">
        <ImageIcon size={40} />
        <div>Failed to load file preview</div>
        <div className="max-w-md break-all text-center text-xs">{filename}</div>
      </div>
    )
  }

  if (!previewUrl) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Loading preview...
      </div>
    )
  }

  const previewPane = isPdf ? (
    <div className="relative flex flex-1 flex-col overflow-auto">
      {findOpen ? (
        <div
          className="absolute top-2 right-2 z-50 flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-800/95 px-2 py-1 shadow-lg backdrop-blur-sm"
          style={{ width: 300 }}
          onKeyDown={handleFindKeyDown}
        >
          <input
            ref={findInputRef}
            type="text"
            value={findQuery}
            onChange={(e) => setFindQuery(e.target.value)}
            placeholder="Find in page..."
            className="min-w-0 flex-1 border-none bg-transparent text-sm text-white outline-none placeholder:text-zinc-500"
          />
          {findQuery ? (
            <span className="shrink-0 text-xs text-zinc-400">
              {totalMatches > 0 ? `${activeMatch} of ${totalMatches}` : 'No matches'}
            </span>
          ) : null}
          <div className="mx-0.5 h-4 w-px bg-zinc-700" />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={findPrevious}
            className="flex size-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:text-zinc-200"
            title="Previous match"
          >
            <ChevronUp size={14} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={findNext}
            className="flex size-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:text-zinc-200"
            title="Next match"
          >
            <ChevronDown size={14} />
          </Button>
          <div className="mx-0.5 h-4 w-px bg-zinc-700" />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={closeFindBar}
            className="flex size-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:text-zinc-200"
            title="Close"
          >
            <X size={14} />
          </Button>
        </div>
      ) : null}
      {/* Why: Electron's Chromium PDF viewer can fail to initialize inside a
          sandboxed iframe even when the Blob URL is valid. Using <embed> keeps
          the preview isolated to the browser's native PDF surface without
          depending on iframe document execution. */}
      <embed
        src={`${previewUrl}#navpanes=0`}
        type={mimeType}
        className="flex-1 min-h-[24rem] w-full bg-background"
      />
    </div>
  ) : (
    <div
      className="flex flex-1 items-center justify-center overflow-auto bg-muted/20 p-4 cursor-pointer"
      onClick={() => setIsPopupOpen(true)}
      title="Open image in popup"
    >
      <div
        className="flex items-center justify-center"
        style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}
      >
        <img
          src={previewUrl}
          alt={filename}
          className="max-h-full max-w-full object-contain"
          onLoad={(event) => {
            const img = event.currentTarget
            setImageDimensions({ width: img.naturalWidth, height: img.naturalHeight })
          }}
          onError={() => setImageError(true)}
        />
      </div>
    </div>
  )

  return (
    <>
      <div className="flex h-full min-h-0 flex-col">
        {previewPane}
        <div className="flex items-center gap-4 border-t px-4 py-2 text-xs text-muted-foreground">
          {!isPdf && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="rounded p-1 hover:bg-accent hover:text-foreground disabled:opacity-50"
                onClick={() => setZoom((prev) => Math.max(MIN_ZOOM, prev / ZOOM_STEP))}
                disabled={zoom <= MIN_ZOOM}
                title="Zoom out"
              >
                <ZoomOut size={14} />
              </button>
              <button
                type="button"
                className="rounded p-1 hover:bg-accent hover:text-foreground disabled:opacity-50"
                onClick={() => setZoom(1)}
                disabled={zoom === 1}
                title="Reset zoom"
              >
                <RotateCcw size={14} />
              </button>
              <button
                type="button"
                className="rounded p-1 hover:bg-accent hover:text-foreground disabled:opacity-50"
                onClick={() => setZoom((prev) => Math.min(MAX_ZOOM, prev * ZOOM_STEP))}
                disabled={zoom >= MAX_ZOOM}
                title="Zoom in"
              >
                <ZoomIn size={14} />
              </button>
              <span className="ml-1 tabular-nums">{zoomPercent}%</span>
            </div>
          )}
          {isPdf && (
            <button
              type="button"
              className="rounded p-1 hover:bg-accent hover:text-foreground"
              onClick={() => setFindOpen(true)}
              title="Find in PDF (Cmd+F)"
            >
              <Search size={14} />
            </button>
          )}
          <span className="min-w-0 truncate" title={filename}>
            {filename}
          </span>
          {!isPdf && imageDimensions && (
            <span>
              {imageDimensions.width} x {imageDimensions.height}
            </span>
          )}
          {isPdf && <span>PDF preview</span>}
          <span>{estimatedSize}</span>
        </div>
      </div>
      {/* Why: native Chromium PDF embeds need direct pointer input for paging,
          zoom, selection, and sidebar toggles. Intercepting every click to
          force a second modal preview breaks those controls on some Macs and
          can leave the dialog shell visible around a half-initialized viewer. */}
      {!isPdf && (
        <Dialog open={isPopupOpen} onOpenChange={setIsPopupOpen}>
          <DialogContent
            showCloseButton={false}
            className="top-1/2 left-1/2 h-[80vh] w-[70vw] max-w-[70vw] -translate-x-1/2 -translate-y-1/2 gap-0 overflow-hidden border border-border/60 bg-background p-0 shadow-2xl sm:max-w-[70vw]"
          >
            <DialogTitle className="sr-only">{filename}</DialogTitle>
            <DialogDescription className="sr-only">Full-size image preview</DialogDescription>
            <div className="flex items-center justify-between border-b border-border/60 bg-background/95 px-3 py-2">
              <div className="min-w-0 truncate text-sm font-medium text-foreground">{filename}</div>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => setIsPopupOpen(false)}
              >
                <X size={14} />
                <span>Close</span>
              </button>
            </div>
            <div className="flex h-[calc(100%-4.5rem)] w-full min-h-0 items-center justify-center overflow-auto bg-muted/20 p-4">
              <div
                className="flex items-center justify-center"
                style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}
              >
                <img
                  src={previewUrl}
                  alt={filename}
                  className="block max-h-full max-w-full object-contain"
                />
              </div>
            </div>
            <div className="flex items-center justify-between border-t border-border/60 bg-background/95 px-3 py-2 text-xs text-muted-foreground">
              <div>Press Esc to close</div>
              <div className="tabular-nums">{zoomPercent}%</div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
