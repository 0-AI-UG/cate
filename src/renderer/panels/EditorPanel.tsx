// =============================================================================
// EditorPanel — Monaco Editor wrapper for CanvasIDE editor panels.
// Supports both regular editing and git diff viewing modes.
// =============================================================================

import { useEffect, useRef, useCallback, useState } from 'react'
import type { ReactNode } from 'react'
import { Check, Copy } from '@phosphor-icons/react'
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
} from '../lib/editor/editorSaveRegistry'
import { getActiveTheme, subscribeTheme } from '../lib/themeManager'
import type { Theme } from '../../shared/types'
import { takePendingReveal } from '../lib/editor/editorReveal'
import {
  getCachedModel,
  rememberModel,
  retainModel,
  releaseModel,
  resolveLoadedModel,
  markLoadFailed,
  clearLoadFailed,
} from '../lib/editor/modelCache'
import { useFileSync } from '../lib/editor/useFileSync'
import EditorConflictBanner from './EditorConflictBanner'
import { Tooltip } from '../ui/Tooltip'

// -----------------------------------------------------------------------------
// Editor font
// -----------------------------------------------------------------------------

const EDITOR_DEFAULT_FONT_FAMILY = 'Menlo, Monaco, "Courier New", monospace'

/** The editorFontFamily setting, with blank falling back to the default stack. */
function resolveEditorFontFamily(setting: string): string {
  return setting.trim() || EDITOR_DEFAULT_FONT_FAMILY
}

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

// -----------------------------------------------------------------------------
// Monaco theme — a single 'cate-active' theme built from the active unified
// Theme's `editor` block (base + syntax token rules + chrome colors).
// (Re)defining the same name and calling setTheme() re-themes every open editor.
// -----------------------------------------------------------------------------

const CATE_MONACO_THEME = 'cate-active'

function applyMonacoTheme(theme: Theme): void {
  monaco.editor.defineTheme(CATE_MONACO_THEME, {
    base: theme.editor.base,
    inherit: true,
    rules: theme.editor.tokens.map((t) => ({
      token: t.token,
      ...(t.foreground ? { foreground: t.foreground } : {}),
      ...(t.background ? { background: t.background } : {}),
      ...(t.fontStyle ? { fontStyle: t.fontStyle } : {}),
    })),
    colors: theme.editor.colors ?? {},
  })
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
  const diffOverlayRef = useRef<HTMLDivElement>(null)

  const [markdownContent, setMarkdownContent] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)

  const workspaces = useAppStore((s) => s.workspaces)
  const ws = workspaces.find((w) => w.id === workspaceId)
  const diffMode = ws?.panels[panelId]?.diffMode
  // Preview mode is kept per-panel in the store rather than as local state: a
  // single EditorPanel mount is reused across dock tabs (renderPanelComponent
  // creates the element without a key), so local state would leak the toggle
  // from one markdown file to the next. Keying it by panelId also keeps each
  // tab's choice independent across canvas switches.
  const markdownPreview = !!ws?.panels[panelId]?.markdownPreview
  const setMarkdownPreview = useCallback(
    (next: boolean) =>
      useAppStore.getState().setPanelMarkdownPreview(workspaceId, panelId, next),
    [workspaceId, panelId],
  )
  const rootPath = ws?.rootPath
  const isMarkdown = !!filePath && /\.mdx?$/i.test(filePath)

  const markdownPreviewRef = useRef(markdownPreview)
  markdownPreviewRef.current = markdownPreview

  // Live accessor for our Monaco model, handed to the sync hook so it can read
  // and replace the buffer without owning the editor's lifecycle.
  const getModel = useCallback(() => editorRef.current?.getModel() ?? null, [])
  // Keep the markdown preview in step when the hook replaces the buffer from disk
  // (external reload / merge).
  const onExternalReplace = useCallback((content: string) => {
    if (markdownPreviewRef.current) setMarkdownContent(content)
  }, [])

  // The whole buffer↔disk lifecycle lives in this one hook: baseline tracking,
  // dirty state, external-change/delete conflicts, the guarded save, and the
  // reload / keep-mine / keep-both / restore resolutions.
  const sync = useFileSync({
    workspaceId,
    panelId,
    filePath,
    rootPath,
    diffMode,
    getModel,
    onExternalReplace,
  })
  const {
    conflict,
    showDiff,
    save,
    reload,
    keepMine,
    keepBoth,
    openDiff,
    closeDiff,
    saveToRestore,
    dismiss,
  } = sync

  // ---------------------------------------------------------------------------
  // Mount: create regular editor OR diff editor
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!containerRef.current) return

    applyMonacoTheme(getActiveTheme())
    monaco.editor.setTheme(CATE_MONACO_THEME)
    const fontSize = useSettingsStore.getState().editorFontSize
    const fontFamily = resolveEditorFontFamily(useSettingsStore.getState().editorFontFamily)

    // =======================================================================
    // DIFF MODE — Monaco diff editor
    // =======================================================================
    if (diffMode && filePath && rootPath) {
      const diffEditor = monaco.editor.createDiffEditor(containerRef.current, {
        theme: CATE_MONACO_THEME,
        fontFamily,
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
          modifiedContent = await window.electronAPI.fsReadFile(filePath, workspaceId)
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
      theme: CATE_MONACO_THEME,
      fontFamily,
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

    // Jump to a line/column requested by a terminal file-link click (one-shot).
    // Runs after the model is set so the reveal targets real content.
    const applyPendingReveal = () => {
      const reveal = takePendingReveal(panelId)
      if (!reveal) return
      try {
        editor.revealLineInCenter(reveal.line)
        editor.setPosition({ lineNumber: reveal.line, column: reveal.column ?? 1 })
        editor.focus()
      } catch { /* ignore reveal failures (e.g. line beyond EOF) */ }
    }

    let cancelled = false
    let createdModel: monaco.editor.ITextModel | null = null
    let modelRetained = false

    if (filePath) {
      // Reuse a warm model if our LRU has it, otherwise fall back to
      // monaco.editor.getModel(uri) in case Monaco itself still owns one
      // (e.g. across HMR boundaries). Models survive panel unmount in the
      // cache so reopening the same file is instant.
      // A remote/WSL file path is a `cate-runtime://<id>/<path>` locator;
      // monaco.Uri.file() would mangle it, so parse the URI directly. Bare
      // local paths keep using .file(). The LRU cache key is the raw filePath
      // string, which already distinguishes runtimes, so no cache change.
      const fileUri = filePath.startsWith('cate-runtime://')
        ? monaco.Uri.parse(filePath)
        : monaco.Uri.file(filePath)
      let cached = getCachedModel(filePath) as monaco.editor.ITextModel | undefined
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
        applyPendingReveal()
        // The warm model may be stale: nothing kept it current while this panel
        // was closed. Reconcile with disk — a clean buffer silently catches up, a
        // buffer with unsaved edits raises a conflict instead of being clobbered.
        // (resyncFromDisk recovers the real disk baseline from the model cache.)
        void sync.resyncFromDisk()
      } else {
        const language = detectLanguage(filePath)
        const targetPath = filePath
        window.electronAPI
          .fsReadFile(filePath, workspaceId)
          .then((content) => {
            if (cancelled) return
            clearLoadFailed(targetPath)
            setLoadError(null)
            // Pass the file URI so Monaco indexes the model by it; this enables
            // monaco.editor.getModel(uri) reuse on later opens. When two panels
            // open the same uncached file concurrently the URI is already taken,
            // so reuse that model instead of letting createModel() throw.
            const model = resolveLoadedModel(
              () => monaco.editor.getModel(fileUri),
              () => monaco.editor.createModel(content, language, fileUri),
            )
            createdModel = model
            rememberModel(targetPath, model)
            retainModel(targetPath)
            modelRetained = true
            editor.setModel(model)
            // Freshly read from disk — this is our sync point for the save guard.
            sync.noteLoaded(content)
            applyPendingReveal()
          })
          .catch((err) => {
            if (cancelled) return
            log.error('[EditorPanel] Failed to read file:', err)
            // Do NOT cache a placeholder model under the real path or its URI —
            // a later open would hit the cache and show the file as empty, and a
            // Cmd+S from that empty buffer would overwrite the real file. Mark
            // the path as failed (blocks save) and surface a visible error.
            markLoadFailed(targetPath)
            setLoadError(String((err as Error)?.message ?? err))
          })
      }
    } else {
      const restored = useAppStore.getState().workspaces
        .find((w) => w.id === workspaceId)?.panels[panelId]?.unsavedContent ?? ''
      const model = monaco.editor.createModel(restored, 'plaintext')
      createdModel = model
      editor.setModel(model)
      if (restored) {
        sync.noteUserEdit()
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
      // A disk-driven reload/merge (in useFileSync) replaces the model value;
      // that isn't a user edit, so don't flip the panel to dirty.
      if (sync.isExternalReplace()) return
      sync.noteUserEdit()

      // Persist scratch-editor content to the store (debounced) so it
      // survives canvas/workspace switches and app restarts.
      if (!sync.filePathRef.current) {
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
      // Drop any failed-load marker so a remount retries the read from disk
      // instead of staying permanently blocked.
      if (filePath) clearLoadFailed(filePath)
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
  // Watch settings changes: editor font size / family
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
      if (state.editorFontFamily !== prevState.editorFontFamily) {
        const fontFamily = resolveEditorFontFamily(state.editorFontFamily)
        editorRef.current?.updateOptions({ fontFamily })
        diffEditorRef.current?.updateOptions({ fontFamily })
        // Cached glyph metrics belong to the old font; without this, layout
        // (cursor position, selection width) stays measured for the old face.
        monaco.editor.remeasureFonts()
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
        window.electronAPI.fsReadFile(filePath, workspaceId).then(setMarkdownContent).catch(() => {})
      }
    } else {
      // Re-layout Monaco after unhiding — dimensions may have changed while hidden
      editorRef.current?.layout()
      diffEditorRef.current?.layout()
    }
  }, [markdownPreview, isMarkdown, filePath, workspaceId])

  // ---------------------------------------------------------------------------
  // Diff overlay — disk (original) ⇆ unsaved buffer (modified), read-only.
  // Mounted only while the user has the diff open on a `changed` conflict.
  // (The buffer↔disk watch, reload, and conflict logic all live in useFileSync.)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!showDiff || conflict?.kind !== 'changed' || !diffOverlayRef.current) return

    const fontSize = useSettingsStore.getState().editorFontSize
    const fontFamily = resolveEditorFontFamily(useSettingsStore.getState().editorFontFamily)
    const language = filePath ? detectLanguage(filePath) : 'plaintext'
    const bufferValue = editorRef.current?.getModel()?.getValue() ?? ''

    const original = monaco.editor.createModel(conflict.diskContent ?? '', language)
    const modified = monaco.editor.createModel(bufferValue, language)
    const diff = monaco.editor.createDiffEditor(diffOverlayRef.current, {
      theme: CATE_MONACO_THEME,
      fontFamily,
      fontSize: fontSize || 12,
      readOnly: true,
      renderSideBySide: true,
      automaticLayout: false,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      renderOverviewRuler: false,
      overviewRulerLanes: 0,
      scrollbar: {
        verticalScrollbarSize: 8,
        horizontalScrollbarSize: 8,
        verticalSliderSize: 8,
        horizontalSliderSize: 8,
      },
      padding: { top: 8, bottom: 8 },
    })
    diff.setModel({ original, modified })

    const layoutObserver = new ResizeObserver(() => diff.layout())
    layoutObserver.observe(diffOverlayRef.current)

    return () => {
      layoutObserver.disconnect()
      diff.dispose()
      original.dispose()
      modified.dispose()
    }
  }, [showDiff, conflict, filePath])

  // ---------------------------------------------------------------------------
  // Watch app theme changes and update Monaco theme
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const unsub = subscribeTheme((t) => {
      applyMonacoTheme(t)
      monaco.editor.setTheme(CATE_MONACO_THEME)
    })
    return unsub
  }, [])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="w-full h-full flex flex-col">
      {/* Markdown header strip — the Source/Preview toggle lives in its own
          row instead of floating over the first line of content (#370). */}
      {isMarkdown && !diffMode && (
        <div
          className="flex items-center justify-end shrink-0 px-1.5 py-1 border-b border-subtle"
          style={{ backgroundColor: 'var(--node-chrome-bg, var(--surface-1))' }}
        >
          <button
            onClick={() => setMarkdownPreview(!markdownPreview)}
            className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
              markdownPreview
                ? 'bg-agent/15 text-agent hover:bg-agent/25'
                : 'bg-surface-3 text-secondary hover:bg-surface-4 hover:text-primary'
            }`}
            title={markdownPreview ? 'Show source' : 'Preview markdown'}
          >
            {markdownPreview ? 'Source' : 'Preview'}
          </button>
        </div>
      )}
      {conflict && !diffMode && (
        <EditorConflictBanner
          kind={conflict.kind}
          showDiff={showDiff}
          onReload={reload}
          onKeepMine={keepMine}
          onKeepBoth={keepBoth}
          onViewDiff={openDiff}
          onCloseDiff={closeDiff}
          onSaveToRestore={saveToRestore}
          onDismiss={dismiss}
        />
      )}
      <div className="flex-1 min-h-0 relative">
        {showDiff && conflict?.kind === 'changed' && (
          <div className="absolute inset-0 z-30 bg-surface-1">
            <div ref={diffOverlayRef} className="w-full h-full" />
          </div>
        )}
        {markdownPreview && isMarkdown && (
          <MarkdownPreview content={markdownContent} />
        )}
        {loadError && !diffMode && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-1 bg-surface-1 px-6 text-center">
            <div className="text-[13px] font-medium text-primary">Couldn’t open this file</div>
            <div className="text-[12px] text-secondary break-all">{loadError}</div>
          </div>
        )}
        <div ref={containerRef} className={`w-full h-full ${(markdownPreview && isMarkdown) || loadError ? 'hidden' : ''}`} />
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Markdown preview renderer
// -----------------------------------------------------------------------------

/** Fenced code block with a hover copy button, matching the agent chat's
 *  "Copy code" affordance (#373). */
function MarkdownCodeBlock({ children }: { children: ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  return (
    <div className="relative group my-3">
      <pre
        ref={preRef}
        className="rounded-md bg-surface-3 border border-subtle px-4 py-3 overflow-x-auto text-[12px] leading-snug"
      >
        {children}
      </pre>
      <Tooltip label="Copy code">
        <button
          onClick={() => {
            void navigator.clipboard.writeText(preRef.current?.textContent ?? '')
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1200)
          }}
          aria-label="Copy code"
          className={`absolute top-1.5 right-1.5 p-1 rounded-md bg-surface-3 text-muted transition-opacity hover:text-primary hover:bg-hover-strong ${
            copied ? 'opacity-100 text-primary' : 'opacity-0 group-hover:opacity-100'
          }`}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </Tooltip>
    </div>
  )
}

function MarkdownPreview({ content }: { content: string }) {
  return (
    <div className="absolute inset-0 overflow-auto px-6 py-4">
      <div className="max-w-3xl mx-auto prose-markdown space-y-3 text-[13px] text-primary leading-relaxed">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            p: ({ children }) => <p className="leading-relaxed my-2">{children}</p>,
            h1: ({ children }) => <h1 className="text-xl font-bold text-primary mt-6 mb-2 pb-1 border-b border-strong">{children}</h1>,
            h2: ({ children }) => <h2 className="text-lg font-semibold text-primary mt-5 mb-2 pb-1 border-b border-strong">{children}</h2>,
            h3: ({ children }) => <h3 className="text-[15px] font-semibold text-primary mt-4 mb-1">{children}</h3>,
            h4: ({ children }) => <h4 className="text-[14px] font-semibold text-primary mt-3 mb-1">{children}</h4>,
            ul: ({ children }) => <ul className="list-disc pl-5 space-y-1">{children}</ul>,
            ol: ({ children }) => <ol className="list-decimal pl-5 space-y-1">{children}</ol>,
            li: ({ children }) => <li className="leading-relaxed">{children}</li>,
            a: ({ href, children }) => (
              <a href={href} target="_blank" rel="noreferrer"
                 className="text-agent underline decoration-agent/30 hover:decoration-agent">
                {children}
              </a>
            ),
            blockquote: ({ children }) => (
              <blockquote className="border-l-3 border-strong pl-3 text-secondary italic my-2">
                {children}
              </blockquote>
            ),
            hr: () => <hr className="border-subtle my-4" />,
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
                <code className="font-mono text-[12px] px-1 py-[1px] rounded bg-hover-strong text-primary" {...props}>
                  {children}
                </code>
              )
            },
            pre: ({ children }) => <MarkdownCodeBlock>{children}</MarkdownCodeBlock>,
            table: ({ children }) => (
              <div className="overflow-x-auto my-3">
                <table className="min-w-full text-[12px] border border-subtle rounded-md">{children}</table>
              </div>
            ),
            th: ({ children }) => (
              <th className="text-left px-3 py-1.5 border-b border-subtle bg-surface-3 text-primary font-medium">{children}</th>
            ),
            td: ({ children }) => (
              <td className="px-3 py-1.5 border-b border-subtle align-top">{children}</td>
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
