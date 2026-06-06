import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import type { PanelProps } from './types'
import { useAppStore } from '../stores/appStore'
import { ArrowLeft, ArrowRight, Minus, Plus } from '@phosphor-icons/react'
import { errorMessage } from '../lib/errorMessage'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

// ---------------------------------------------------------------------------
// Magic-byte file type detection
// ---------------------------------------------------------------------------

type DocumentType = 'pdf' | 'docx' | 'image'

interface DetectedType {
  documentType: DocumentType
  mimeType: string
}

function detectTypeFromBytes(bytes: Uint8Array): DetectedType | null {
  if (bytes.length < 4) return null

  // PDF: starts with %PDF
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return { documentType: 'pdf', mimeType: 'application/pdf' }
  }

  // JPEG: starts with FF D8 FF
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return { documentType: 'image', mimeType: 'image/jpeg' }
  }

  // PNG: starts with 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    return { documentType: 'image', mimeType: 'image/png' }
  }

  // GIF: starts with GIF8
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return { documentType: 'image', mimeType: 'image/gif' }
  }

  // WebP: starts with RIFF....WEBP
  if (bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return { documentType: 'image', mimeType: 'image/webp' }
  }

  // BMP: starts with BM
  if (bytes[0] === 0x42 && bytes[1] === 0x4D) {
    return { documentType: 'image', mimeType: 'image/bmp' }
  }

  // TIFF: starts with II (little-endian) or MM (big-endian)
  if ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2A && bytes[3] === 0x00) ||
      (bytes[0] === 0x4D && bytes[1] === 0x4D && bytes[2] === 0x00 && bytes[3] === 0x2A)) {
    return { documentType: 'image', mimeType: 'image/tiff' }
  }

  // ICO: starts with 00 00 01 00
  if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) {
    return { documentType: 'image', mimeType: 'image/x-icon' }
  }

  // SVG: look for <?xml or <svg near the start
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 256))
  if (head.includes('<svg') || (head.includes('<?xml') && head.includes('<svg'))) {
    return { documentType: 'image', mimeType: 'image/svg+xml' }
  }

  // DOCX (ZIP with PK signature — check for word/ entry marker)
  if (bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04) {
    const asText = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 2000))
    if (asText.includes('word/')) {
      return { documentType: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Sub-viewers
// ---------------------------------------------------------------------------

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function ImageViewer({ data, mimeType, fileName }: { data: Uint8Array; mimeType: string; fileName: string }) {
  const dataUrl = useMemo(() => {
    const b64 = uint8ToBase64(data)
    return `data:${mimeType};base64,${b64}`
  }, [data, mimeType])

  return (
    <div className="flex-1 flex items-center justify-center overflow-auto p-4 bg-neutral-900/50">
      <img
        src={dataUrl}
        alt={fileName}
        className="max-w-full max-h-full object-contain rounded"
        draggable={false}
      />
    </div>
  )
}

function PdfViewer({ data }: { data: Uint8Array }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [numPages, setNumPages] = useState(0)
  const [scale, setScale] = useState(1.5)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null)

  useEffect(() => {
    let cancelled = false
    const loadingTask = pdfjsLib.getDocument({ data })
    loadingTask.promise.then((doc) => {
      if (cancelled) return
      setPdf(doc)
      setNumPages(doc.numPages)
    })
    return () => {
      cancelled = true
      loadingTask.destroy()
    }
  }, [data])

  useEffect(() => {
    if (!pdf || !canvasRef.current) return
    let cancelled = false

    if (renderTaskRef.current) {
      renderTaskRef.current.cancel()
      renderTaskRef.current = null
    }

    pdf.getPage(currentPage).then((page) => {
      if (cancelled || !canvasRef.current) return
      const viewport = page.getViewport({ scale })
      const canvas = canvasRef.current
      const ctx = canvas.getContext('2d')!
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.floor(viewport.width * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const task = page.render({ canvasContext: ctx, viewport, canvas })
      renderTaskRef.current = task
      task.promise.catch(() => {})
    })

    return () => { cancelled = true }
  }, [pdf, currentPage, scale])

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-neutral-800/60 border-b border-white/5 text-xs text-neutral-400">
        <button
          onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
          disabled={currentPage <= 1}
          className="p-1 rounded hover:bg-white/10 disabled:opacity-30"
        >
          <ArrowLeft size={14} />
        </button>
        <span>
          {currentPage} / {numPages}
        </span>
        <button
          onClick={() => setCurrentPage((p) => Math.min(numPages, p + 1))}
          disabled={currentPage >= numPages}
          className="p-1 rounded hover:bg-white/10 disabled:opacity-30"
        >
          <ArrowRight size={14} />
        </button>
        <div className="w-px h-4 bg-white/10 mx-1" />
        <button
          onClick={() => setScale((s) => Math.max(0.5, s - 0.25))}
          className="p-1 rounded hover:bg-white/10"
        >
          <Minus size={14} />
        </button>
        <span>{Math.round(scale * 100)}%</span>
        <button
          onClick={() => setScale((s) => Math.min(4, s + 0.25))}
          className="p-1 rounded hover:bg-white/10"
        >
          <Plus size={14} />
        </button>
      </div>
      <div ref={containerRef} className="flex-1 overflow-auto flex justify-center p-4 bg-neutral-900/50">
        <canvas ref={canvasRef} className="shadow-lg" />
      </div>
    </div>
  )
}

function DocxViewer({ data }: { data: Uint8Array }) {
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    import('mammoth').then((mammoth) => {
      mammoth.convertToHtml({ arrayBuffer: (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength) }).then((result) => {
        if (!cancelled) setHtml(result.value)
      }).catch((err) => {
        if (!cancelled) setError(errorMessage(err, 'Failed to render document'))
      })
    })
    return () => { cancelled = true }
  }, [data])

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-red-400 text-sm p-4">
        Failed to render document: {error}
      </div>
    )
  }

  if (!html) {
    return (
      <div className="flex-1 flex items-center justify-center text-neutral-500 text-sm">
        Converting…
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-auto p-6 bg-neutral-900/50">
      <div
        className="prose prose-invert prose-sm max-w-3xl mx-auto"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function DocumentPanel({ panelId, workspaceId }: PanelProps) {
  const panelState = useAppStore((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId) ?? s.workspaces.find((w) => w.id === s.selectedWorkspaceId)
    return ws?.panels[panelId]
  })

  const filePath = panelState?.filePath
  const storeDocumentType = panelState?.documentType

  const [data, setData] = useState<Uint8Array | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fileName = filePath?.split('/').pop() ?? 'Document'

  const detected = useMemo(() => {
    if (!data) return null
    return detectTypeFromBytes(data)
  }, [data])

  const documentType = detected?.documentType ?? storeDocumentType
  const mimeType = detected?.mimeType ?? 'application/octet-stream'

  const openExternal = useCallback(() => {
    if (filePath) {
      window.electronAPI.shellShowInFolder(filePath)
    }
  }, [filePath])

  useEffect(() => {
    if (!filePath) {
      setError('No file path provided')
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    window.electronAPI.fsReadBinary(filePath, workspaceId).then((buffer) => {
      if (!cancelled) {
        setData(new Uint8Array(buffer))
        setLoading(false)
      }
    }).catch((err) => {
      if (!cancelled) {
        setError(errorMessage(err, 'Failed to load file'))
        setLoading(false)
      }
    })

    return () => { cancelled = true }
  }, [filePath, workspaceId])

  if (loading) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-surface-4 text-neutral-500 text-sm">
        Loading {fileName}…
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-surface-4 gap-2">
        <span className="text-red-400 text-sm">{error ?? 'Failed to load file'}</span>
        <button
          onClick={openExternal}
          className="text-xs text-neutral-400 hover:text-white underline"
        >
          Show in Finder
        </button>
      </div>
    )
  }

  return (
    <div className="w-full h-full flex flex-col bg-surface-4">
      {documentType === 'image' && <ImageViewer data={data} mimeType={mimeType} fileName={fileName} />}
      {documentType === 'pdf' && <PdfViewer data={data} />}
      {documentType === 'docx' && <DocxViewer data={data} />}
      {!documentType && (
        <div className="flex-1 flex items-center justify-center text-neutral-500 text-sm">
          Unsupported file format
        </div>
      )}
    </div>
  )
}
