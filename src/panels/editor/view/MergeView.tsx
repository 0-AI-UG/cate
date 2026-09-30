// The conflict view: the file on disk beside the unsaved buffer, read-only.
// The person settles it from the banner (reload, keep mine, keep both); the
// runtime runs the three-way merge.

import { useEffect, useRef, useState } from 'react'
import type * as Y from 'yjs'
import { errorMessage } from '@kernel/ui'
import { fsClient } from '@workspace/files/client'
import { useTextContent } from './bufferText'
import { CATE_MONACO_THEME, detectLanguage, monaco } from './monacoSetup'
import type { EditorFont } from './editorSettings'

export function MergeView({ workspaceId, filePath, text, font }: {
  workspaceId: string
  filePath: string
  text: Y.Text | null
  font: EditorFont
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const modelsRef = useRef<{ original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel } | null>(null)
  const [disk, setDisk] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const mine = useTextContent(text)

  useEffect(() => {
    let current = true
    setDisk(null)
    fsClient(workspaceId).read(filePath).then(
      (file) => { if (current) setDisk(file.content) },
      (err) => { if (current) setError(errorMessage(err, 'Could not read the file on disk.')) },
    )
    return () => { current = false }
  }, [workspaceId, filePath])

  useEffect(() => {
    if (!containerRef.current || disk === null) return
    const language = detectLanguage(filePath)
    const original = monaco.editor.createModel(disk, language)
    const modified = monaco.editor.createModel('', language)
    modelsRef.current = { original, modified }
    const diff = monaco.editor.createDiffEditor(containerRef.current, {
      theme: CATE_MONACO_THEME,
      fontFamily: font.fontFamily,
      fontSize: font.fontSize,
      readOnly: true,
      renderSideBySide: true,
      automaticLayout: false,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      renderOverviewRuler: false,
      overviewRulerLanes: 0,
      padding: { top: 8, bottom: 8 },
    })
    diff.setModel({ original, modified })
    const observer = new ResizeObserver(() => diff.layout())
    observer.observe(containerRef.current)
    return () => {
      modelsRef.current = null
      observer.disconnect()
      diff.dispose()
      original.dispose()
      modified.dispose()
    }
  }, [disk, filePath, font.fontFamily, font.fontSize])

  useEffect(() => {
    const models = modelsRef.current
    if (models && models.modified.getValue() !== mine) models.modified.setValue(mine)
  }, [mine, disk])

  return (
    <div className="absolute inset-0 z-30 bg-surface-1" data-testid="merge-view">
      {error && <div className="p-3 text-xs text-error">{error}</div>}
      <div ref={containerRef} className="w-full h-full" />
    </div>
  )
}
