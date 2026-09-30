// Monaco bound to a buffer's Y.Text through y-monaco. Each panel gets its own
// model (the panel id is in the URI), so two panels of one file on this
// client never bind the same model twice; both bind the same Y.Text.

import { useEffect, useRef } from 'react'
import type * as Y from 'yjs'
import { MonacoBinding } from 'y-monaco'
import { getActiveTheme, subscribeTheme } from '@kernel/ui'
import { CATE_MONACO_THEME, applyMonacoTheme, detectLanguage, monaco } from './monacoSetup'
import type { EditorFont } from './editorSettings'

export interface CodeEditorProps {
  panelId: string
  filePath: string
  text: Y.Text | null
  font: EditorFont
  hidden?: boolean
  /** The editor instance, once created and bound; null when gone. */
  onEditor?: (editor: monaco.editor.IStandaloneCodeEditor | null) => void
}

export function revealLine(editor: monaco.editor.IStandaloneCodeEditor, line: number, column?: number | null): void {
  try {
    editor.revealLineInCenter(line)
    editor.setPosition({ lineNumber: line, column: column ?? 1 })
    editor.focus()
  } catch { /* a line beyond the end */ }
}

export function CodeEditor({ panelId, filePath, text, font, hidden, onEditor }: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const onEditorRef = useRef(onEditor)
  onEditorRef.current = onEditor

  useEffect(() => {
    if (!containerRef.current) return
    applyMonacoTheme(getActiveTheme())
    const editor = monaco.editor.create(containerRef.current, {
      model: null,
      theme: CATE_MONACO_THEME,
      fontFamily: font.fontFamily,
      fontSize: font.fontSize,
      minimap: { enabled: false },
      automaticLayout: false,
      scrollBeyondLastLine: false,
      scrollbar: { useShadows: false, verticalScrollbarSize: 8.45, horizontalScrollbarSize: 8.45, verticalSliderSize: 8.45, horizontalSliderSize: 8.45 },
      lineNumbersMinChars: 3,
      lineDecorationsWidth: 6,
      glyphMargin: false,
      overviewRulerLanes: 0,
      overviewRulerBorder: false,
      padding: { top: 8, bottom: 8 },
      lineNumbers: 'on',
      renderWhitespace: 'none',
      wordWrap: 'on',
    })
    editorRef.current = editor
    const observer = new ResizeObserver(() => editor.layout())
    observer.observe(containerRef.current)
    const offTheme = subscribeTheme((theme) => applyMonacoTheme(theme))
    return () => {
      offTheme()
      observer.disconnect()
      onEditorRef.current?.(null)
      editor.dispose()
      editorRef.current = null
    }
    // Font changes are applied below without recreating the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize: font.fontSize, fontFamily: font.fontFamily })
    // Cached glyph metrics belong to the old face.
    monaco.editor.remeasureFonts()
  }, [font.fontSize, font.fontFamily])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !text) return
    const uri = monaco.Uri.file(filePath).with({ query: `panel=${panelId}` })
    monaco.editor.getModel(uri)?.dispose()
    const model = monaco.editor.createModel('', detectLanguage(filePath), uri)
    const binding = new MonacoBinding(text, model, new Set([editor]))
    editor.setModel(model)
    onEditorRef.current?.(editor)
    return () => {
      onEditorRef.current?.(null)
      binding.destroy()
      editor.setModel(null)
      model.dispose()
    }
  }, [panelId, filePath, text])

  useEffect(() => {
    if (!hidden) editorRef.current?.layout()
  }, [hidden])

  return <div ref={containerRef} data-testid="code-editor" className={`w-full h-full ${hidden ? 'hidden' : ''}`} />
}
