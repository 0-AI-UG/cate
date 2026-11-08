import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import { ArrowLeft, ArrowRight, Minus, Plus } from 'lucide-react'
import { LoadingState } from '../../kernel/interaction'
import { errorMessage } from '@kernel/interaction'
import { DocumentErrorState } from './DocumentErrorState'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()

// One page of the continuous PDF view. It takes its size from the page as
// soon as the page loads and keeps a backing store only while near the viewport.
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
  const rendering = useRef<Promise<void>>(Promise.resolve())

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
      ([entry]) => setVisible(entry.isIntersecting),
      { root, rootMargin: '100% 0px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [root])

  useEffect(() => {
    if (!page || !visible || !canvasRef.current) return
    const canvas = canvasRef.current
    let cancelled = false
    let task: pdfjsLib.RenderTask | undefined
    // A cancelled render must settle before the same canvas can be reused.
    rendering.current = rendering.current.then(async () => {
      if (cancelled) return
      const viewport = page.getViewport({ scale })
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.floor(viewport.width * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
      const ctx = canvas.getContext('2d')!
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      task = page.render({ canvasContext: ctx, viewport, canvas })
      await task.promise
    }).catch((err) => {
      if (!cancelled && !(err instanceof pdfjsLib.RenderingCancelledException)) setError(errorMessage(err, 'Failed to render page'))
    })
    return () => {
      cancelled = true
      task?.cancel()
      canvas.width = 0
      canvas.height = 0
    }
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
        : <canvas ref={canvasRef} width={0} height={0} className="block w-full h-full" />}
    </div>
  )
}

export default function PdfViewer({ data }: { data: Uint8Array }) {
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
