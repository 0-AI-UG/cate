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
import { registerEditorSave, unregisterEditorSave } from '../lib/editorSaveRegistry'
import { getResolvedTheme, subscribeTheme } from '../lib/themeManager'

// -----------------------------------------------------------------------------
// Monaco worker setup for Electron (Vite bundler)
// -----------------------------------------------------------------------------

let monacoWorkersShuttingDown = false

if (typeof window !== 'undefined') {
  window.addEventListener(
    'beforeunload',
    () => {
      monacoWorkersShuttingDown = true
    },
    { once: true },
  )
}

function createMonacoWorker(url: URL, label: string): Worker {
  return new Worker(url, {
    type: 'module',
    name: `monaco-${label || 'worker'}`,
  })
}

function createBundledMonacoWorker(label: string): Worker {
  const normalizedLabel = label.toLowerCase()

  if (monacoWorkersShuttingDown) {
    return new Worker(new URL('../workers/noop.worker.ts', import.meta.url), {
      type: 'module',
      name: `monaco-${normalizedLabel || 'noop'}`,
    })
  }

  if (normalizedLabel === 'json' || normalizedLabel === 'jsonc') {
    return createMonacoWorker(
      new URL('monaco-editor/esm/vs/language/json/json.worker.js', import.meta.url),
      normalizedLabel,
    )
  }

  if (normalizedLabel === 'css' || normalizedLabel === 'scss' || normalizedLabel === 'less') {
    return createMonacoWorker(
      new URL('monaco-editor/esm/vs/language/css/css.worker.js', import.meta.url),
      normalizedLabel,
    )
  }

  if (normalizedLabel === 'html' || normalizedLabel === 'handlebars' || normalizedLabel === 'razor') {
    return createMonacoWorker(
      new URL('monaco-editor/esm/vs/language/html/html.worker.js', import.meta.url),
      normalizedLabel,
    )
  }

  if (
    normalizedLabel === 'typescript'
    || normalizedLabel === 'javascript'
    || normalizedLabel === 'typescriptreact'
    || normalizedLabel === 'javascriptreact'
  ) {
    return createMonacoWorker(
      new URL('monaco-editor/esm/vs/language/typescript/ts.worker.js', import.meta.url),
      normalizedLabel,
    )
  }

  return new Worker(new URL('../workers/editorService.worker.ts', import.meta.url), {
    type: 'module',
    name: `monaco-${normalizedLabel || 'worker'}`,
  })
}

const monacoGlobal = globalThis as typeof globalThis & {
  MonacoEnvironment?: Record<string, unknown> & {
    getWorker?: (moduleId: string, label: string) => Worker
  }
}

monacoGlobal.MonacoEnvironment = {
  ...(monacoGlobal.MonacoEnvironment ?? {}),
  getWorker: function (_: string, label: string) {
    try {
      return createBundledMonacoWorker(label)
    } catch (err) {
      log.error('[EditorPanel] Failed to create Monaco worker for label %s:', label, err)
      throw err
    }
  },
}

// LRU cap on Monaco model cache so long sessions don't accumulate models for
// every file the user has ever opened. Oldest entries are disposed on eviction.
const MODEL_CACHE_LIMIT = 20

// -----------------------------------------------------------------------------
// Module-level model cache keyed by file path
// -----------------------------------------------------------------------------

const modelCache = new Map<string, monaco.editor.ITextModel>()
// Counts how many mounted EditorPanel instances are actively using a cached model.
const modelRefCount = new Map<string, number>()

function rememberModel(filePath: string, model: monaco.editor.ITextModel): void {
  // Map preserves insertion order — re-insert to mark as most recent.
  modelCache.delete(filePath)
  modelCache.set(filePath, model)
  while (modelCache.size > MODEL_CACHE_LIMIT) {
    const oldestKey = modelCache.keys().next().value
    if (oldestKey === undefined) break
    // Don't evict a model that is still in use by a mounted editor.
    if ((modelRefCount.get(oldestKey) ?? 0) > 0) break
    const oldest = modelCache.get(oldestKey)
    modelCache.delete(oldestKey)
    if (oldest && !oldest.isDisposed()) {
      try { oldest.dispose() } catch { /* noop */ }
    }
  }
}

function retainModel(filePath: string): void {
  modelRefCount.set(filePath, (modelRefCount.get(filePath) ?? 0) + 1)
}

function releaseModel(filePath: string): void {
  const count = (modelRefCount.get(filePath) ?? 0) - 1
  if (count <= 0) {
    modelRefCount.delete(filePath)
    const model = modelCache.get(filePath)
    if (model && !model.isDisposed()) {
      modelCache.delete(filePath)
      try { model.dispose() } catch { /* noop */ }
    }
  } else {
    modelRefCount.set(filePath, count)
  }
}

// -----------------------------------------------------------------------------
// Custom Monaco themes — one per app theme.
// Defined once at module load; setTheme() swaps them at runtime.
// -----------------------------------------------------------------------------

let cateThemesDefined = false

function ensureCateThemes() {
  if (cateThemesDefined) return

  // Dark Warm — original warm palette, canvas-node background #1f1e1c
  monaco.editor.defineTheme('cate-dark-warm', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#1f1e1c',
      'editorGutter.background': '#1f1e1c',
      'minimap.background': '#1f1e1c',
      'editor.lineHighlightBorder': '#00000000',
      'contrastBorder': '#00000000',
    },
  })

  // Dark Cold — VS Code Dark+ defaults, minimal overrides
  monaco.editor.defineTheme('cate-dark-cold', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#1e1e1e',
      'editorGutter.background': '#1e1e1e',
      'minimap.background': '#1e1e1e',
      'editor.lineHighlightBorder': '#00000000',
      'contrastBorder': '#00000000',
    },
  })

  // Light Subtle — Solarized-warm cream palette matching app chrome
  monaco.editor.defineTheme('cate-light-subtle', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#ddd5ca',
      'editorGutter.background': '#ddd5ca',
      'minimap.background': '#ddd5ca',
      'editor.foreground': '#38322b',
      'editorLineNumber.foreground': '#8a8274',
      'editorLineNumber.activeForeground': '#38322b',
      'editor.lineHighlightBackground': '#e5dfd6',
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': '#c8bfb0',
      'editorCursor.foreground': '#3c7ef0',
      'contrastBorder': '#00000000',
    },
  })

  cateThemesDefined = true
}

function resolvedMonacoTheme(): string {
  return 'cate-' + getResolvedTheme()
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

  const workspaces = useAppStore((s) => s.workspaces)
  const ws = workspaces.find((w) => w.id === workspaceId)
  const diffMode = ws?.panels[panelId]?.diffMode
  const rootPath = ws?.rootPath

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

    ensureCateThemes()
    monaco.editor.setTheme(resolvedMonacoTheme())
    const fontSize = useSettingsStore.getState().editorFontSize

    // =======================================================================
    // DIFF MODE — Monaco diff editor
    // =======================================================================
    if (diffMode && filePath && rootPath) {
      const diffEditor = monaco.editor.createDiffEditor(containerRef.current, {
        theme: resolvedMonacoTheme(),
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
      theme: resolvedMonacoTheme(),
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: fontSize || 12,
      minimap: { enabled: false },
      automaticLayout: false,
      scrollBeyondLastLine: false,
      scrollbar: { useShadows: false },
      overviewRulerBorder: false,
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
    let createdModel: monaco.editor.ITextModel | null = null
    let modelRetained = false

    if (filePath) {
      const cached = modelCache.get(filePath)
      if (cached && !cached.isDisposed()) {
        retainModel(filePath)
        modelRetained = true
        editor.setModel(cached)
      } else {
        const language = detectLanguage(filePath)
        window.electronAPI
          .fsReadFile(filePath)
          .then((content) => {
            if (cancelled) return
            const model = monaco.editor.createModel(content, language)
            createdModel = model
            rememberModel(filePath, model)
            retainModel(filePath)
            modelRetained = true
            editor.setModel(model)
          })
          .catch((err) => {
            if (cancelled) return
            log.error('[EditorPanel] Failed to read file:', err)
            const model = monaco.editor.createModel('', language)
            createdModel = model
            rememberModel(filePath, model)
            retainModel(filePath)
            modelRetained = true
            editor.setModel(model)
          })
      }
    } else {
      const restored = useAppStore.getState().workspaces
        .find((w) => w.id === workspaceId)?.panels[panelId]?.unsavedContent ?? ''
      const model = monaco.editor.createModel(restored, 'plaintext')
      createdModel = model
      editor.setModel(model)
      if (restored) {
        isDirtyRef.current = true
        useAppStore.getState().setPanelDirty(workspaceId, panelId, true)
      }
    }

    let unsavedSaveTimer: ReturnType<typeof setTimeout> | null = null
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

      // Persist scratch-editor content to the store (debounced) so it
      // survives canvas/workspace switches and app restarts.
      if (!filePathRef.current) {
        if (unsavedSaveTimer) clearTimeout(unsavedSaveTimer)
        unsavedSaveTimer = setTimeout(() => {
          const value = editor.getModel()?.getValue() ?? ''
          useAppStore.getState().setPanelUnsavedContent(workspaceId, panelId, value || undefined)
        }, 300)
      }
    })

    return () => {
      cancelled = true
      layoutObserver.disconnect()
      changeDisposable.dispose()
      if (unsavedSaveTimer) {
        clearTimeout(unsavedSaveTimer)
        unsavedSaveTimer = null
      }
      if (!filePath) {
        const value = editor.getModel()?.getValue() ?? ''
        useAppStore.getState().setPanelUnsavedContent(workspaceId, panelId, value || undefined)
      }
      if (filePath && modelRetained) {
        releaseModel(filePath)
      } else if (!filePath && createdModel && !createdModel.isDisposed()) {
        createdModel.dispose()
      }
      editor.dispose()
      editorRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, workspaceId, diffMode])

  // ---------------------------------------------------------------------------
  // Listen for save-file custom event
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const handler = () => { save() }
    window.addEventListener('save-file', handler)
    registerEditorSave(panelId, save)
    return () => {
      window.removeEventListener('save-file', handler)
      unregisterEditorSave(panelId)
    }
  }, [save, panelId])

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
  // Watch app theme changes and update Monaco theme
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const unsub = subscribeTheme(() => {
      monaco.editor.setTheme(resolvedMonacoTheme())
    })
    return unsub
  }, [])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const showBreadcrumb = !!filePath && !diffMode
  return (
    <div className="w-full h-full flex flex-col">
      {showBreadcrumb && <EditorBreadcrumb filePath={filePath!} rootPath={rootPath} />}
      <div ref={containerRef} className="flex-1 min-h-0 w-full" />
    </div>
  )
}

// -----------------------------------------------------------------------------
// Breadcrumb strip — workspace-relative path segments above the editor
// -----------------------------------------------------------------------------

function EditorBreadcrumb({ filePath, rootPath }: { filePath: string; rootPath?: string }) {
  const rel = rootPath && filePath.startsWith(rootPath + '/')
    ? filePath.slice(rootPath.length + 1)
    : filePath
  const segments = rel.split('/').filter(Boolean)
  return (
    <div
      className="flex items-center gap-1 px-2 py-0.5 text-[11px] text-neutral-500 dark:text-neutral-400 border-b border-neutral-200 dark:border-neutral-800 overflow-hidden whitespace-nowrap select-none"
      title={filePath}
    >
      {segments.map((seg, i) => (
        <span key={i} className="flex items-center gap-1 min-w-0">
          {i > 0 && <span className="opacity-50">›</span>}
          <span className={i === segments.length - 1 ? 'text-neutral-700 dark:text-neutral-200 truncate' : 'truncate'}>
            {seg}
          </span>
        </span>
      ))}
    </div>
  )
}
