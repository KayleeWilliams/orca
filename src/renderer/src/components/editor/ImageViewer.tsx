import { Image as ImageIcon, RotateCcw, Search, X, ZoomIn, ZoomOut } from 'lucide-react'
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { ORCA_PDF_VIEWER_PARTITION } from '../../../../shared/constants'
import PdfFind from './PdfFind'

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
  const webviewRef = useRef<Electron.WebviewTag | null>(null)

  const filename = useMemo(() => filePath.split(/[/\\]/).pop() || filePath, [filePath])
  const cleanedContent = useMemo(() => content.replace(/\s/g, ''), [content])
  const isPdf = mimeType === 'application/pdf'
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  // Why: for PDFs we store content via IPC to a main-process memory store
  // and load it via the custom orca-pdf: protocol in a webview. This avoids
  // cross-origin blob URL issues that prevent webviews from loading
  // renderer-created blob URLs.
  const [pdfProtocolUrl, setPdfProtocolUrl] = useState<string | null>(null)
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
    if (!cleanedContent || isPdf) {
      setPreviewUrl(null)
      return
    }
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
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }))
    setPreviewUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [cleanedContent, mimeType, isPdf])

  useEffect(() => {
    if (!isPdf || !cleanedContent) {
      setPdfProtocolUrl(null)
      return
    }
    let storeId: string | null = null
    let cancelled = false
    window.api.ui.storePdfForViewer(cleanedContent).then((id) => {
      if (cancelled) {
        window.api.ui.releasePdfFromViewer(id)
        return
      }
      storeId = id
      setPdfProtocolUrl(`orca-pdf://${id}`)
    })
    return () => {
      cancelled = true
      if (storeId) {
        window.api.ui.releasePdfFromViewer(storeId)
      }
    }
  }, [isPdf, cleanedContent])

  const closeFindBar = useCallback(() => setFindOpen(false), [])

  // Why: when the webview has focus, keyboard events go to the guest process
  // and don't propagate to the renderer's DOM. This handler only fires when
  // focus is outside the webview. The Search button in the toolbar is the
  // reliable entry point when the PDF has focus.
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

  if (imageError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-muted/20 p-8 text-sm text-muted-foreground">
        <ImageIcon size={40} />
        <div>Failed to load file preview</div>
        <div className="max-w-md break-all text-center text-xs">{filename}</div>
      </div>
    )
  }

  if ((isPdf && !pdfProtocolUrl) || (!isPdf && !previewUrl)) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Loading preview...
      </div>
    )
  }

  const previewPane = isPdf ? (
    <div className="relative flex flex-1 flex-col overflow-auto">
      <PdfFind isOpen={findOpen} onClose={closeFindBar} webviewRef={webviewRef} />
      {/* Why: the PDF viewer webview loads content via the custom orca-pdf:
          protocol served from a main-process memory store. This sidesteps
          cross-origin blob URL limitations and data URL issues that prevent
          Chromium's PDF viewer from activating in webview guests. Using a
          webview gives us webview.findInPage() to search the PDF text layer. */}
      <webview
        ref={webviewRef}
        src={pdfProtocolUrl!}
        partition={ORCA_PDF_VIEWER_PARTITION}
        className="flex-1 min-h-[24rem] w-full bg-background"
        style={{ display: 'inline-flex' }}
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
          src={previewUrl!}
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
                  src={previewUrl!}
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
