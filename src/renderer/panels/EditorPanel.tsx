// =============================================================================
// EditorPanel — Monaco Editor wrapper for CanvasIDE editor panels.
// Supports both regular editing and git diff viewing modes.
// =============================================================================

import { useEffect, useRef, useCallback, useState } from 'react'
import { useRenderCount } from '../lib/perf/perfClient'
import log from '../lib/logger'
import * as monaco from 'monaco-editor'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { EditorPanelProps } from './types'
import { useAppStore } from '../stores/appStore'
import { useSettingsStore } from '../stores/settingsStore'
import {
  registerEditorSave,
  unregisterEditorSave,
  markEditorActive,
  clearEditorActive,
  getActiveEditorPanelId,
} from '../lib/editorSaveRegistry'
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

// MonacoEnvironment.getWorker is assigned once at module load. Monaco caches
// workers by label internally (one tsserver worker, one json worker, etc.) and
// reuses them across all editor instances — no per-panel worker spawn.
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
    // Drop the refcount entry but DO NOT dispose the model. Keeping it warm in
    // the LRU cache makes the next open of the same file instant (no re-read,
    // no re-tokenization). The LRU eviction path in rememberModel() will
    // dispose the model later if it falls out of the cache.
    modelRefCount.delete(filePath)
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
  useRenderCount('EditorPanel')
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const isDirtyRef = useRef(false)
  const filePathRef = useRef(filePath)

  // Only overwrite the ref from the prop when the prop is itself defined.
  // In detached/dock windows the shell keeps its own local `panels` state
  // and doesn't observe the global appStore update we issue after a
  // Save-As, so the `filePath` prop stays undefined for the lifetime of
  // this mount. Without this guard, every re-render would wipe out the
  // path we just learned and the next Cmd+S would re-open Save-As.
  if (filePath !== undefined) filePathRef.current = filePath

  const [markdownPreview, setMarkdownPreview] = useState(false)
  const [markdownContent, setMarkdownContent] = useState('')

  const workspaces = useAppStore((s) => s.workspaces)
  const ws = workspaces.find((w) => w.id === workspaceId)
  const diffMode = ws?.panels[panelId]?.diffMode
  const rootPath = ws?.rootPath
  const isMarkdown = !!filePath && /\.mdx?$/i.test(filePath)

  // ---------------------------------------------------------------------------
  // Save handler (regular editor only)
  // ---------------------------------------------------------------------------

  const save = useCallback(async (): Promise<boolean> => {
    const editor = editorRef.current
    if (!editor || diffMode) return false

    const content = editor.getValue()

    // Untitled buffer (no filePath): prompt the user for a destination via the
    // native Save-As dialog. Once a path is chosen, persist it on the panel
    // state so future saves (Cmd+S, close-confirm) write to the same file.
    let targetPath = filePathRef.current
    let isInitialSave = false
    if (!targetPath) {
      const currentPanel = useAppStore
        .getState()
        .workspaces.find((w) => w.id === workspaceId)?.panels[panelId]
      const cleanTitle = currentPanel?.title?.replace(/\s•\s*$/, '').trim()
      const defaultName = cleanTitle && cleanTitle !== 'Untitled' ? cleanTitle : 'Untitled.txt'
      // Pick the separator that matches the workspace root so the prefilled
      // path looks native on the user's platform (Electron's Save dialog
      // accepts either on Windows but mixed slashes look sloppy).
      const sep = rootPath?.includes('\\') ? '\\' : '/'
      const defaultPath = rootPath ? `${rootPath}${sep}${defaultName}` : defaultName
      const chosen = await window.electronAPI.saveFileDialog({ defaultName, defaultPath })
      if (!chosen) return false
      targetPath = chosen
      isInitialSave = true
    }

    try {
      await window.electronAPI.fsWriteFile(targetPath, content)
    } catch (err) {
      log.error('[EditorPanel] Failed to save file:', err)
      return false
    }

    isDirtyRef.current = false
    useAppStore.getState().setPanelDirty(workspaceId, panelId, false)

    // Use both separators so the basename is correct on Windows (`\\`) as
    // well as POSIX (`/`).
    const fileName = targetPath.split(/[\\/]/).pop() || 'Untitled'
    useAppStore.getState().updatePanelTitle(workspaceId, panelId, fileName)

    if (isInitialSave) {
      // Persist the new filePath in the global appStore (the source of
      // truth for the main window's panels). In detached/dock windows the
      // shell maintains its own local panels state instead, so we ALSO
      // update filePathRef directly: that makes the next Cmd+S in this
      // exact mount write to the chosen file instead of reopening Save-As,
      // regardless of whether the prop ever updates.
      filePathRef.current = targetPath
      useAppStore.getState().updatePanelFilePath(workspaceId, panelId, targetPath)
      // Clear the unsaved-content cache so the remount-from-disk path is
      // the single source of truth for the editor model when the prop
      // does flip (main window).
      useAppStore.getState().setPanelUnsavedContent(workspaceId, panelId, undefined)
      // Notify the surrounding shell (DockWindowShell / PanelWindowShell)
      // so its local `panels` state — which feeds session sync and close
      // prompts in detached windows — picks up the new filePath, title,
      // and clean dirty flag. The main window ignores this event because
      // it reads from appStore directly.
      window.dispatchEvent(
        new CustomEvent('editor:panel-saved-as', {
          detail: { panelId, filePath: targetPath, title: fileName },
        }),
      )
    }
    return true
  }, [workspaceId, panelId, diffMode, rootPath])

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
        useInlineViewWhenSpaceIsLimited: false,
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

      let cancelled = false

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

        if (cancelled) return

        const originalModel = monaco.editor.createModel(originalContent, language)
        const modifiedModel = monaco.editor.createModel(modifiedContent, language)

        diffEditor.setModel({
          original: originalModel,
          modified: modifiedModel,
        })
      }

      loadDiff()

      return () => {
        cancelled = true
        layoutObserver.disconnect()
        const model = diffEditor.getModel()
        // Dispose the diff editor BEFORE its models — Monaco's DiffEditorWidget
        // still references them during teardown and throws "TextModel got disposed
        // before DiffEditorWidget model got reset" otherwise.
        diffEditor.dispose()
        model?.original?.dispose()
        model?.modified?.dispose()
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
      // Reuse a warm model if our LRU has it, otherwise fall back to
      // monaco.editor.getModel(uri) in case Monaco itself still owns one
      // (e.g. across HMR boundaries). Models survive panel unmount in the
      // cache so reopening the same file is instant.
      const fileUri = monaco.Uri.file(filePath)
      let cached = modelCache.get(filePath)
      if (!cached || cached.isDisposed()) {
        const byUri = monaco.editor.getModel(fileUri)
        if (byUri && !byUri.isDisposed()) {
          cached = byUri
          rememberModel(filePath, byUri)
        }
      }
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
            // Pass the file URI so Monaco indexes the model by it; this
            // enables monaco.editor.getModel(uri) reuse on later opens.
            const model = monaco.editor.createModel(content, language, fileUri)
            createdModel = model
            rememberModel(filePath, model)
            retainModel(filePath)
            modelRetained = true
            editor.setModel(model)
          })
          .catch((err) => {
            if (cancelled) return
            log.error('[EditorPanel] Failed to read file:', err)
            // No URI here — we don't want a malformed/empty placeholder to
            // squat on the file URI and be reused as the real model later.
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

    // Track which editor most recently held text focus so the window-level
    // Cmd+S handler can route to the correct panel even after focus moves
    // off the textarea (e.g. clicking the markdown preview toggle).
    const focusDisposable = editor.onDidFocusEditorText(() => {
      markEditorActive(panelId)
    })

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
      focusDisposable.dispose()
      clearEditorActive(panelId)
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
    // Cmd+S / Ctrl+S broadcasts a window-wide `save-file` event. Without a
    // gate every mounted EditorPanel would react — and for an untitled
    // buffer that would open a Save-As picker for each scratch editor on
    // the canvas. We route the event to whichever editor most recently held
    // Monaco text focus (tracked in editorSaveRegistry). This survives the
    // user clicking off the textarea onto e.g. the markdown preview toggle,
    // which would defeat a raw `hasTextFocus()` check.
    const handler = () => {
      if (getActiveEditorPanelId() === panelId) save()
    }
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
  // Sync markdown content when preview is toggled on
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (markdownPreview && isMarkdown) {
      const model = editorRef.current?.getModel()
      if (model && !model.isDisposed()) {
        setMarkdownContent(model.getValue())
      } else if (filePath) {
        window.electronAPI.fsReadFile(filePath).then(setMarkdownContent).catch(() => {})
      }
    } else {
      // Re-layout Monaco after unhiding — dimensions may have changed while hidden
      editorRef.current?.layout()
      diffEditorRef.current?.layout()
    }
  }, [markdownPreview, isMarkdown, filePath])

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

  return (
    <div className="w-full h-full relative">
      {isMarkdown && !diffMode && (
        <button
          onClick={() => setMarkdownPreview((v) => !v)}
          className={`absolute top-2 right-5 z-10 px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
            markdownPreview
              ? 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30'
              : 'bg-neutral-200/80 dark:bg-neutral-700/80 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-300 dark:hover:bg-neutral-600'
          }`}
          title={markdownPreview ? 'Show source' : 'Preview markdown'}
        >
          {markdownPreview ? 'Source' : 'Preview'}
        </button>
      )}
      {markdownPreview && isMarkdown && (
        <MarkdownPreview content={markdownContent} />
      )}
      <div ref={containerRef} className={`w-full h-full ${markdownPreview && isMarkdown ? 'hidden' : ''}`} />
    </div>
  )
}

// -----------------------------------------------------------------------------
// Markdown preview renderer
// -----------------------------------------------------------------------------

function MarkdownPreview({ content }: { content: string }) {
  return (
    <div className="absolute inset-0 overflow-auto px-6 py-4">
      <div className="max-w-3xl mx-auto prose-markdown space-y-3 text-[13px] text-primary leading-relaxed">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            p: ({ children }) => <p className="leading-relaxed my-2">{children}</p>,
            h1: ({ children }) => <h1 className="text-xl font-bold text-primary mt-6 mb-2 pb-1 border-b border-neutral-300 dark:border-neutral-700">{children}</h1>,
            h2: ({ children }) => <h2 className="text-lg font-semibold text-primary mt-5 mb-2 pb-1 border-b border-neutral-300 dark:border-neutral-700">{children}</h2>,
            h3: ({ children }) => <h3 className="text-[15px] font-semibold text-primary mt-4 mb-1">{children}</h3>,
            h4: ({ children }) => <h4 className="text-[14px] font-semibold text-primary mt-3 mb-1">{children}</h4>,
            ul: ({ children }) => <ul className="list-disc pl-5 space-y-1">{children}</ul>,
            ol: ({ children }) => <ol className="list-decimal pl-5 space-y-1">{children}</ol>,
            li: ({ children }) => <li className="leading-relaxed">{children}</li>,
            a: ({ href, children }) => (
              <a href={href} target="_blank" rel="noreferrer"
                 className="text-blue-500 dark:text-blue-400 underline decoration-blue-500/30 hover:decoration-blue-500">
                {children}
              </a>
            ),
            blockquote: ({ children }) => (
              <blockquote className="border-l-3 border-neutral-400 dark:border-neutral-600 pl-3 text-primary/80 italic my-2">
                {children}
              </blockquote>
            ),
            hr: () => <hr className="border-neutral-300 dark:border-neutral-700 my-4" />,
            strong: ({ children }) => <strong className="font-semibold text-primary">{children}</strong>,
            em: ({ children }) => <em className="italic">{children}</em>,
            code: ({ className, children, ...props }) => {
              const isBlock = /language-/.test(className ?? '')
              if (isBlock) {
                return (
                  <code className={`${className ?? ''} font-mono text-[12px] leading-snug`} {...props}>
                    {children}
                  </code>
                )
              }
              return (
                <code className="font-mono text-[12px] px-1 py-[1px] rounded bg-neutral-200 dark:bg-neutral-800 text-pink-600 dark:text-pink-400" {...props}>
                  {children}
                </code>
              )
            },
            pre: ({ children }) => (
              <pre className="rounded-md bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 px-4 py-3 overflow-x-auto text-[12px] leading-snug my-3">
                {children}
              </pre>
            ),
            table: ({ children }) => (
              <div className="overflow-x-auto my-3">
                <table className="min-w-full text-[12px] border border-neutral-200 dark:border-neutral-700 rounded-md">{children}</table>
              </div>
            ),
            th: ({ children }) => (
              <th className="text-left px-3 py-1.5 border-b border-neutral-200 dark:border-neutral-700 bg-neutral-100 dark:bg-neutral-800 font-medium">{children}</th>
            ),
            td: ({ children }) => (
              <td className="px-3 py-1.5 border-b border-neutral-100 dark:border-neutral-800 align-top">{children}</td>
            ),
            img: ({ src, alt }) => (
              <img src={src} alt={alt ?? ''} className="max-w-full rounded-md my-2" />
            ),
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    </div>
  )
}
