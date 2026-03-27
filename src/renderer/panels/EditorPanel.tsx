// =============================================================================
// EditorPanel — Monaco Editor wrapper for CanvasIDE editor panels.
// Ported from EditorPanel.swift (edit/save/dirty logic).
// =============================================================================

import { useEffect, useRef, useCallback } from 'react'
import * as monaco from 'monaco-editor'
import type { EditorPanelProps } from './types'
import { useAppStore } from '../stores/appStore'
import { useSettingsStore } from '../stores/settingsStore'

// -----------------------------------------------------------------------------
// Monaco worker setup for Electron (Vite bundler)
// -----------------------------------------------------------------------------

window.MonacoEnvironment = {
  getWorker: function (_: string, label: string) {
    // In electron-vite, the simplest reliable approach is the base editor worker
    // for all languages. Language services still work via the main thread fallback.
    return new Worker(
      new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
      { type: 'module' },
    )
  },
}

// -----------------------------------------------------------------------------
// Language detection from file extension
// -----------------------------------------------------------------------------

function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase()
  if (!ext) return 'plaintext'

  // Try to match against Monaco's registered languages
  const languages = monaco.languages.getLanguages()
  for (const lang of languages) {
    if (lang.extensions?.some((e) => e === `.${ext}` || e === ext)) {
      return lang.id
    }
  }

  // Common fallbacks not always registered at init time
  const fallbackMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescriptreact',
    js: 'javascript',
    jsx: 'javascriptreact',
    json: 'json',
    md: 'markdown',
    py: 'python',
    rs: 'rust',
    go: 'go',
    rb: 'ruby',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'toml',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    htm: 'html',
    xml: 'xml',
    svg: 'xml',
    swift: 'swift',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    hpp: 'cpp',
    java: 'java',
    kt: 'kotlin',
    sql: 'sql',
    graphql: 'graphql',
    dockerfile: 'dockerfile',
    makefile: 'makefile',
  }

  return fallbackMap[ext] ?? 'plaintext'
}

// -----------------------------------------------------------------------------
// EditorPanel component
// -----------------------------------------------------------------------------

export default function EditorPanel({
  panelId,
  workspaceId,
  nodeId,
  filePath,
}: EditorPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const isDirtyRef = useRef(false)
  const filePathRef = useRef(filePath)

  // Keep filePath ref in sync
  filePathRef.current = filePath

  // ---------------------------------------------------------------------------
  // Save handler
  // ---------------------------------------------------------------------------

  const save = useCallback(async () => {
    const editor = editorRef.current
    if (!editor || !filePathRef.current) return

    const content = editor.getValue()

    try {
      await window.electronAPI.fsWriteFile(filePathRef.current, content)
    } catch (err) {
      console.error('[EditorPanel] Failed to save file:', err)
      return
    }

    // Clear dirty state
    isDirtyRef.current = false
    useAppStore.getState().setPanelDirty(workspaceId, panelId, false)

    // Update title: remove dirty marker
    const fileName = filePathRef.current.split('/').pop() ?? 'Untitled'
    useAppStore.getState().updatePanelTitle(workspaceId, panelId, fileName)
  }, [workspaceId, panelId])

  // ---------------------------------------------------------------------------
  // Mount: create editor & load file
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!containerRef.current) return

    const fontSize = useSettingsStore.getState().editorFontSize

    const editor = monaco.editor.create(containerRef.current, {
      theme: 'vs-dark',
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: fontSize || 12,
      minimap: { enabled: false },
      automaticLayout: true,
      scrollBeyondLastLine: false,
      padding: { top: 8, bottom: 8 },
      lineNumbers: 'on',
      renderWhitespace: 'none',
      wordWrap: 'on',
    })

    editorRef.current = editor

    // Load file content or set empty model
    if (filePath) {
      const language = detectLanguage(filePath)
      window.electronAPI
        .fsReadFile(filePath)
        .then((content) => {
          const model = monaco.editor.createModel(content, language)
          editor.setModel(model)
        })
        .catch((err) => {
          console.error('[EditorPanel] Failed to read file:', err)
          const model = monaco.editor.createModel('', language)
          editor.setModel(model)
        })
    } else {
      const model = monaco.editor.createModel('', 'plaintext')
      editor.setModel(model)
    }

    // Listen for content changes -> mark dirty
    const changeDisposable = editor.onDidChangeModelContent(() => {
      if (!isDirtyRef.current) {
        isDirtyRef.current = true
        useAppStore.getState().setPanelDirty(workspaceId, panelId, true)

        // Update title with dirty marker
        if (filePathRef.current) {
          const fileName = filePathRef.current.split('/').pop() ?? 'Untitled'
          useAppStore
            .getState()
            .updatePanelTitle(workspaceId, panelId, `${fileName} \u2022`)
        }
      }
    })

    // Cleanup on unmount
    return () => {
      changeDisposable.dispose()
      const model = editor.getModel()
      if (model) model.dispose()
      editor.dispose()
      editorRef.current = null
    }
    // filePath is intentionally only used on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelId, workspaceId])

  // ---------------------------------------------------------------------------
  // Listen for save-file custom event (dispatched by shortcut handler on Cmd+S)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const handler = () => {
      save()
    }
    window.addEventListener('save-file', handler)
    return () => window.removeEventListener('save-file', handler)
  }, [save])

  // ---------------------------------------------------------------------------
  // Watch settings changes: editor font size
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const unsub = useSettingsStore.subscribe((state, prevState) => {
      if (
        state.editorFontSize !== prevState.editorFontSize &&
        editorRef.current
      ) {
        editorRef.current.updateOptions({ fontSize: state.editorFontSize })
      }
    })
    return unsub
  }, [])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return <div ref={containerRef} className="w-full h-full" />
}
