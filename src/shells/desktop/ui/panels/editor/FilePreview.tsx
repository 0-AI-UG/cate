// Previews of images, PDFs and DOCX files. The bytes are fetched from the
// runtime (`file.readBinary`), never pushed through the session, and fetched
// again when the file changes on disk.

import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { LoadingState, PanelCenteredState } from '../../kernel/interaction'
import { errorMessage } from '@kernel/interaction'
import { fsClient, watchFsRoot } from '@workspace/files/client'
import { getDocumentType, pathDisplayName, pathKey } from '@workspace/files/contract'
import { detectTypeFromBytes, viewedArrayBuffer } from './parts/fileBytes'
import { DocumentErrorState } from './DocumentErrorState'

const PdfViewer = lazy(() => import('./PdfViewer'))

function ImageViewer({ data, mimeType, fileName }: { data: Uint8Array; mimeType: string; fileName: string }) {
  const [src, setSrc] = useState<string>()
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([viewedArrayBuffer(data)], { type: mimeType }))
    setSrc(url)
    return () => URL.revokeObjectURL(url)
  }, [data, mimeType])
  return (
    <div className="flex-1 flex items-center justify-center overflow-auto p-4 bg-neutral-900/50">
      <img src={src} alt={fileName} className="max-w-full max-h-full object-contain rounded" draggable={false} />
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
      {documentType === 'pdf' && <Suspense fallback={<LoadingState label="Opening PDF" className="flex-1 text-sm" />}><PdfViewer data={state.data} /></Suspense>}
      {documentType === 'docx' && <DocxViewer data={state.data} />}
      {!documentType && <PanelCenteredState title="Unsupported file format" />}
    </div>
  )
}
