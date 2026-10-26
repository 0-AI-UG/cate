// Previews of images, PDFs and DOCX files. The bytes are fetched from the
// runtime (`file.readBinary`), never pushed through the session, and fetched
// again when the file changes on disk.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import { ArrowLeft, ArrowRight, Minus, Plus } from 'lucide-react'
import { LoadingState, PanelCenteredState } from '../../kernel/interaction'
import { errorMessage } from '@kernel/interaction'
import { fsClient, watchFsRoot } from '@workspace/files/client'
import { getDocumentType, pathDisplayName, pathKey } from '@workspace/files/contract'
import { bytesToBase64, detectTypeFromBytes, viewedArrayBuffer } from './parts/fileBytes'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()

function DocumentErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-surface-4 gap-2 p-4 text-center">
      <span className="text-red-400 text-sm">{message}</span>
      <button onClick={onRetry} className="text-xs text-neutral-400 hover:text-white underline">Try Again</button>
    </div>
  )
}

function ImageViewer({ data, mimeType, fileName }: { data: Uint8Array; mimeType: string; fileName: string }) {
  const src = useMemo(() => `data:${mimeType};base64,${bytesToBase64(data)}`, [data, mimeType])
  return (
    <div className="flex-1 flex items-center justify-center overflow-auto p-4 bg-neutral-900/50">
      <img src={src} alt={fileName} className="max-w-full max-h-full object-contain rounded" draggable={false} />
    </div>
  )
}

// One page of the continuous PDF view. It takes its size from the page as
// soon as the page loads and draws only once it scrolls near the viewport.
function PdfPage({ pdf, pageNumber, scale, placeholder, root, pageRef }: {
  pdf: pdfjsLib.PDFDocumentProxy
  pageNumber: number
  scale: number
  placeholder: { width: number; height: number }
  root: HTMLElement | null
  pageRef: (el: HTMLDivElement | null) => void
}) {
  const [page, setPage] = useState<pdfjsLib.PDFPageProxy | null>(null)
  const [visible, setVisible] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let cancelled = false
    pdf.getPage(pageNumber).then(
      (p) => { if (!cancelled) setPage(p) },
      (err) => { if (!cancelled) setError(errorMessage(err, 'Failed to load page')) },
    )
    return () => { cancelled = true }
  }, [pdf, pageNumber])

  useEffect(() => {
    const el = containerRef.current
    if (!el || !root) return
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setVisible(true) },
      { root, rootMargin: '100% 0px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [root])

  useEffect(() => {
    if (!page || !visible || !canvasRef.current) return
    const viewport = page.getViewport({ scale })
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')!
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.floor(viewport.width * dpr)
    canvas.height = Math.floor(viewport.height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const task = page.render({ canvasContext: ctx, viewport, canvas })
    task.promise.catch((err) => {
      if (!(err instanceof pdfjsLib.RenderingCancelledException)) setError(errorMessage(err, 'Failed to render page'))
    })
    return () => task.cancel()
  }, [page, visible, scale])

  const size = page ? page.getViewport({ scale }) : { width: placeholder.width * scale, height: placeholder.height * scale }
  return (
    <div
      ref={(el) => { containerRef.current = el; pageRef(el) }}
      className="relative shrink-0 bg-white shadow-lg"
      style={{ width: size.width, height: size.height }}
    >
      {error
        ? <span className="absolute inset-0 flex items-center justify-center text-red-400 text-sm">{error}</span>
        : <canvas ref={canvasRef} className="block w-full h-full" />}
    </div>
  )
}

function PdfViewer({ data }: { data: Uint8Array }) {
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null)
  const [placeholder, setPlaceholder] = useState({ width: 612, height: 792 })
  const [currentPage, setCurrentPage] = useState(1)
  const [numPages, setNumPages] = useState(0)
  const [scale, setScale] = useState(1.5)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const pageEls = useRef<(HTMLDivElement | null)[]>([])
  const scrollRatio = useRef(0)

  useEffect(() => {
    let cancelled = false
    setError(null)
    const loadingTask = pdfjsLib.getDocument({ data: data.slice() })
    loadingTask.promise.then(async (doc) => {
      const first = (await doc.getPage(1)).getViewport({ scale: 1 })
      if (cancelled) return
      setPlaceholder({ width: first.width, height: first.height })
      setPdf(doc)
      setNumPages(doc.numPages)
      setCurrentPage(1)
    }).catch((err) => {
      if (!cancelled) setError(errorMessage(err, 'Failed to open PDF'))
    })
    return () => {
      cancelled = true
      // destroy() rejects the in-flight promise; the task is being torn down.
      loadingTask.destroy().catch(() => {})
    }
  }, [data, reloadKey])

  // Zooming keeps the same spot of the document in view.
  useLayoutEffect(() => {
    if (scroller) scroller.scrollTop = scrollRatio.current * scroller.scrollHeight
  }, [scale, scroller])

  const onScroll = () => {
    if (!scroller) return
    scrollRatio.current = scroller.scrollHeight ? scroller.scrollTop / scroller.scrollHeight : 0
    const middle = scroller.scrollTop + scroller.clientHeight / 2
    let page = 1
    pageEls.current.forEach((el, i) => { if (el && el.offsetTop <= middle) page = i + 1 })
    setCurrentPage(page)
  }

  const goToPage = (page: number) => {
    const el = pageEls.current[page - 1]
    if (scroller && el) scroller.scrollTop = el.offsetTop - 16
  }

  if (error) {
    return <DocumentErrorState message={error} onRetry={() => { setPdf(null); setNumPages(0); setReloadKey((k) => k + 1) }} />
  }
  if (!pdf) return <LoadingState label="Opening PDF" className="flex-1 text-sm" />
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-neutral-800/60 border-b border-subtle text-xs text-neutral-400">
        <button onClick={() => goToPage(currentPage - 1)} disabled={currentPage <= 1} className="p-1 rounded-lg hover:bg-white/10 disabled:opacity-30" aria-label="Previous page"><ArrowLeft size={14} /></button>
        <span>{currentPage} / {numPages}</span>
        <button onClick={() => goToPage(currentPage + 1)} disabled={currentPage >= numPages} className="p-1 rounded-lg hover:bg-white/10 disabled:opacity-30" aria-label="Next page"><ArrowRight size={14} /></button>
        <div className="w-px h-4 bg-white/10 mx-1" />
        <button onClick={() => setScale((s) => Math.max(0.5, s - 0.25))} className="p-1 rounded-lg hover:bg-white/10" aria-label="Zoom out"><Minus size={14} /></button>
        <span>{Math.round(scale * 100)}%</span>
        <button onClick={() => setScale((s) => Math.min(4, s + 0.25))} className="p-1 rounded-lg hover:bg-white/10" aria-label="Zoom in"><Plus size={14} /></button>
      </div>
      <div ref={setScroller} onScroll={onScroll} className="relative flex-1 overflow-auto bg-neutral-900/50">
        <div className="flex flex-col items-center gap-4 p-4 w-max min-w-full">
          {Array.from({ length: numPages }, (_, i) => (
            <PdfPage
              key={i}
              pdf={pdf}
              pageNumber={i + 1}
              scale={scale}
              placeholder={placeholder}
              root={scroller}
              pageRef={(el) => { pageEls.current[i] = el }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function DocxViewer({ data }: { data: Uint8Array }) {
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  useEffect(() => {
    let cancelled = false
    setError(null)
    setHtml(null)
    import('mammoth')
      .then((mammoth) => mammoth.convertToHtml({ arrayBuffer: viewedArrayBuffer(data) }))
      .then((result) => { if (!cancelled) setHtml(result.value) })
      .catch((err) => { if (!cancelled) setError(errorMessage(err, 'Failed to render document')) })
    return () => { cancelled = true }
  }, [data, reloadKey])
  if (error) return <DocumentErrorState message={error} onRetry={() => setReloadKey((k) => k + 1)} />
  if (!html) return <LoadingState label="Converting document" className="flex-1 text-sm" />
  return (
    <div className="flex-1 overflow-auto p-6 bg-neutral-900/50">
      <div className="prose prose-invert prose-sm max-w-3xl mx-auto" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}

const parentDir = (file: string) => file.replace(/[/\\][^/\\]*$/, '') || file

export default function FilePreview({ workspaceId, filePath }: { workspaceId: string; filePath: string }) {
  const [loaded, setLoaded] = useState<{ path: string; data: Uint8Array | null; error: string | null } | null>(null)
  const [revision, setRevision] = useState(0)

  useEffect(() => watchFsRoot(workspaceId, parentDir(filePath), (change) => {
    if (pathKey(change.path) === pathKey(filePath)) setRevision((r) => r + 1)
  }), [workspaceId, filePath])

  useEffect(() => {
    let current = true
    fsClient(workspaceId).readBinary(filePath).then(
      (data) => { if (current) setLoaded({ path: filePath, data, error: null }) },
      (err) => { if (current) setLoaded({ path: filePath, data: null, error: errorMessage(err, 'Failed to load file') }) },
    )
    return () => { current = false }
  }, [workspaceId, filePath, revision])

  const state = loaded?.path === filePath ? loaded : null
  const detected = useMemo(() => (state?.data ? detectTypeFromBytes(state.data) : null), [state?.data])
  const fileName = pathDisplayName(filePath) || 'Document'
  const documentType = detected?.documentType ?? getDocumentType(filePath)
  const mimeType = detected?.mimeType ?? 'application/octet-stream'

  if (!state) return <LoadingState label={`Loading ${fileName}`} className="w-full h-full bg-surface-4 text-sm" />
  if (state.error || !state.data) {
    return (
      <PanelCenteredState
        title="Couldn’t open this document"
        description={<span className="text-danger">{state.error ?? 'Failed to load file'}</span>}
      />
    )
  }
  return (
    <div className="w-full h-full flex flex-col bg-surface-4" data-testid="file-preview">
      {documentType === 'image' && <ImageViewer data={state.data} mimeType={mimeType} fileName={fileName} />}
      {documentType === 'pdf' && <PdfViewer data={state.data} />}
      {documentType === 'docx' && <DocxViewer data={state.data} />}
      {!documentType && <PanelCenteredState title="Unsupported file format" />}
    </div>
  )
}
