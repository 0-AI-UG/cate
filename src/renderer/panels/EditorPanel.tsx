// =============================================================================
// EditorPanel — Monaco Editor wrapper for CanvasIDE editor panels.
// Supports both regular editing and git diff viewing modes.
// =============================================================================

import { useEffect, useRef, useCallback } from 'react'
import log from '../lib/logger'
import * as monaco from 'monaco-editor'
import type { EditorPanelProps } from './types'
import { useAppStore } from '../stores/appStore'
import { useSettingsStore } from '../stores/settingsStore'

// -----------------------------------------------------------------------------
// Monaco worker setup for Electron (Vite bundler)
// -----------------------------------------------------------------------------

window.MonacoEnvironment = {
  getWorker: function (_: string, label: string) {
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

  const languages = monaco.languages.getLanguages()
  for (const lang of languages) {
    if (lang.extensions?.some((e) => e === `.${ext}` || e === ext)) {
      return lang.id
    }
  }

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
// Helper: reconstruct original content from current content + unified diff
// -----------------------------------------------------------------------------

function reconstructOriginalFromDiff(currentContent: string, diff: string): string {
  if (!diff) return currentContent

  const currentLines = currentContent.split('\n')
  const diffLines = diff.split('\n')
  const originalLines: string[] = []

  let currentIdx = 0
  let i = 0

  // Skip diff headers (diff --git, index, ---, +++)
  while (i < diffLines.length && !diffLines[i].startsWith('@@')) {
    i++
  }

  while (i < diffLines.length) {
    const line = diffLines[i]

    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
      if (match) {
        const newStart = parseInt(match[3], 10) - 1

        // Copy unchanged lines before this hunk
        while (currentIdx < newStart && currentIdx < currentLines.length) {
          originalLines.push(currentLines[currentIdx])
          currentIdx++
        }
      }
      i++
      continue
    }

    if (line.startsWith('-')) {
      // Line exists in original but was removed
      originalLines.push(line.slice(1))
      i++
    } else if (line.startsWith('+')) {
      // Line was added in modified — skip in original
      currentIdx++
      i++
    } else {
      // Context line
      originalLines.push(currentLines[currentIdx] ?? line.slice(1))
      currentIdx++
      i++
    }
  }

  // Copy remaining unchanged lines
  while (currentIdx < currentLines.length) {
    originalLines.push(currentLines[currentIdx])
    currentIdx++
  }

  return originalLines.join('\n')
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
  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const isDirtyRef = useRef(false)
  const filePathRef = useRef(filePath)

  filePathRef.current = filePath

  const diffMode = useAppStore((s) => {
    const ws = s.workspaces.find(w => w.id === workspaceId)
    return ws?.panels[panelId]?.diffMode
  })

  const rootPath = useAppStore((s) => {
    const ws = s.workspaces.find(w => w.id === workspaceId)
    return ws?.rootPath
  })

  // ---------------------------------------------------------------------------
  // Save handler (regular editor only)
  // ---------------------------------------------------------------------------

  const save = useCallback(async () => {
    const editor = editorRef.current
    if (!editor || !filePathRef.current || diffMode) return

    const content = editor.getValue()

    try {
      await window.electronAPI.fsWriteFile(filePathRef.current, content)
    } catch (err) {
      log.error('[EditorPanel] Failed to save file:', err)
      return
    }

    isDirtyRef.current = false
    useAppStore.getState().setPanelDirty(workspaceId, panelId, false)

    const fileName = filePathRef.current.split('/').pop() ?? 'Untitled'
    useAppStore.getState().updatePanelTitle(workspaceId, panelId, fileName)
  }, [workspaceId, panelId, diffMode])

  // ---------------------------------------------------------------------------
  // Mount: create regular editor OR diff editor
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!containerRef.current) return

    const fontSize = useSettingsStore.getState().editorFontSize

    // =======================================================================
    // DIFF MODE — Monaco diff editor
    // =======================================================================
    if (diffMode && filePath && rootPath) {
      const diffEditor = monaco.editor.createDiffEditor(containerRef.current, {
        theme: 'vs-dark',
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        fontSize: fontSize || 12,
        automaticLayout: false,
        readOnly: true,
        renderSideBySide: true,
        scrollBeyondLastLine: false,
        minimap: { enabled: false },
        padding: { top: 8, bottom: 8 },
      })

      diffEditorRef.current = diffEditor

      const layoutObserver = new ResizeObserver(() => {
        diffEditor.layout()
      })
      layoutObserver.observe(containerRef.current)

      const language = detectLanguage(filePath)
      const relativePath = filePath.startsWith(rootPath)
        ? filePath.slice(rootPath.length + 1)
        : filePath

      const loadDiff = async () => {
        let modifiedContent = ''
        try {
          modifiedContent = await window.electronAPI.fsReadFile(filePath)
        } catch { /* empty */ }

        let originalContent = ''
        try {
          const diff = diffMode === 'staged'
            ? await window.electronAPI.gitDiffStaged(rootPath, relativePath)
            : await window.electronAPI.gitDiff(rootPath, relativePath)
          originalContent = reconstructOriginalFromDiff(modifiedContent, diff)
        } catch {
          originalContent = modifiedContent
        }

        const originalModel = monaco.editor.createModel(originalContent, language)
        const modifiedModel = monaco.editor.createModel(modifiedContent, language)

        diffEditor.setModel({
          original: originalModel,
          modified: modifiedModel,
        })
      }

      loadDiff()

      return () => {
        layoutObserver.disconnect()
        const model = diffEditor.getModel()
        if (model) {
          model.original?.dispose()
          model.modified?.dispose()
        }
        diffEditor.dispose()
        diffEditorRef.current = null
      }
    }

    // =======================================================================
    // REGULAR EDITOR
    // =======================================================================
    const editor = monaco.editor.create(containerRef.current, {
      theme: 'vs-dark',
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: fontSize || 12,
      minimap: { enabled: false },
      automaticLayout: false,
      scrollBeyondLastLine: false,
      padding: { top: 8, bottom: 8 },
      lineNumbers: 'on',
      renderWhitespace: 'none',
      wordWrap: 'on',
    })

    const layoutObserver = new ResizeObserver(() => {
      editor.layout()
    })
    layoutObserver.observe(containerRef.current)

    editorRef.current = editor

    let cancelled = false

    if (filePath) {
      const language = detectLanguage(filePath)
      window.electronAPI
        .fsReadFile(filePath)
        .then((content) => {
          if (cancelled) return
          const model = monaco.editor.createModel(content, language)
          editor.setModel(model)
        })
        .catch((err) => {
          if (cancelled) return
          log.error('[EditorPanel] Failed to read file:', err)
          const model = monaco.editor.createModel('', language)
          editor.setModel(model)
        })
    } else {
      const model = monaco.editor.createModel('', 'plaintext')
      editor.setModel(model)
    }

    const changeDisposable = editor.onDidChangeModelContent(() => {
      if (!isDirtyRef.current) {
        isDirtyRef.current = true
        useAppStore.getState().setPanelDirty(workspaceId, panelId, true)

        if (filePathRef.current) {
          const fileName = filePathRef.current.split('/').pop() ?? 'Untitled'
          useAppStore
            .getState()
            .updatePanelTitle(workspaceId, panelId, `${fileName} \u2022`)
        }
      }
    })

    return () => {
      cancelled = true
      layoutObserver.disconnect()
      changeDisposable.dispose()
      const model = editor.getModel()
      if (model) model.dispose()
      editor.dispose()
      editorRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelId, workspaceId, diffMode])

  // ---------------------------------------------------------------------------
  // Listen for save-file custom event
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const handler = () => { save() }
    window.addEventListener('save-file', handler)
    return () => window.removeEventListener('save-file', handler)
  }, [save])

  // ---------------------------------------------------------------------------
  // Watch settings changes: editor font size
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const unsub = useSettingsStore.subscribe((state, prevState) => {
      if (state.editorFontSize !== prevState.editorFontSize) {
        if (editorRef.current) {
          editorRef.current.updateOptions({ fontSize: state.editorFontSize })
        }
        if (diffEditorRef.current) {
          diffEditorRef.current.updateOptions({ fontSize: state.editorFontSize })
        }
      }
    })
    return unsub
  }, [])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return <div ref={containerRef} className="w-full h-full" />
}
