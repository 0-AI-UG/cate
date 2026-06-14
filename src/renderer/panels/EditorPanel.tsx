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
  isLoadFailed,
} from '../lib/editor/modelCache'
import { watchFsRoot } from '../lib/fs/fsWatchManager'
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

// File paths whose model is mid external-reload (setValue pulled from disk). A
// shared cached model can back several editors, so the setValue fires
// onDidChangeModelContent on every one of them — we mark the path here for the
// synchronous duration of setValue so those change events aren't mistaken for a
// user edit and flip the panel(s) to dirty.
const externalReloadPaths = new Set<string>()

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
  const isDirtyRef = useRef(false)
  const filePathRef = useRef(filePath)

  // Only overwrite the ref from the prop when the prop is itself defined.
  // In detached/dock windows the shell keeps its own local `panels` state
  // and doesn't observe the global appStore update we issue after a
  // Save-As, so the `filePath` prop stays undefined for the lifetime of
  // this mount. Without this guard, every re-render would wipe out the
  // path we just learned and the next Cmd+S would re-open Save-As.
  if (filePath !== undefined) filePathRef.current = filePath

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

  // ---------------------------------------------------------------------------
  // Save handler (regular editor only)
  // ---------------------------------------------------------------------------

  const save = useCallback(async (): Promise<boolean> => {
    const editor = editorRef.current
    if (!editor || diffMode) return false

    // Never write a buffer that failed to load (or never finished loading) back
    // to disk — its contents are an empty placeholder, not the user's file, and
    // saving would truncate the real file.
    if (filePathRef.current && isLoadFailed(filePathRef.current)) {
      log.warn('[EditorPanel] Refusing to save — file never loaded successfully:', filePathRef.current)
      return false
    }

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
      await window.electronAPI.fsWriteFile(targetPath, content, workspaceId)
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
      // Notify the surrounding detached/dock shell (DockWindowShell) so its
      // session sync — which feeds persistence and close prompts in detached
      // windows — flushes the new filePath, title, and clean dirty flag. The
      // main window ignores this event because it reads from appStore directly.
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
      // A remote/WSL file path is a `cate-companion://<id>/<path>` locator;
      // monaco.Uri.file() would mangle it, so parse the URI directly. Bare
      // local paths keep using .file(). The LRU cache key is the raw filePath
      // string, which already distinguishes companions, so no cache change.
      const fileUri = filePath.startsWith('cate-companion://')
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
      // A disk-driven reload (see the fs-watch effect below) replaces the model
      // value; that isn't a user edit, so don't flip the panel to dirty.
      if (filePathRef.current && externalReloadPaths.has(filePathRef.current)) return
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
  // Reload the editor model when the file changes on disk externally
  //
  // Monaco models are cached at module level and survive panel unmount, and the
  // markdown preview renders from the model's value — so without this an edit
  // made by an external tool (another editor, an AI agent, git checkout) never
  // reaches the open buffer or its preview, and reopening the file reuses the
  // stale cached model. Watch the workspace root (the watcher is refcounted and
  // shared with the file explorer, so this adds no new OS watcher) and pull the
  // fresh content into the model when our file is updated on disk. Skipped while
  // the buffer is dirty so we never clobber the user's unsaved edits.
  // ---------------------------------------------------------------------------

  const markdownPreviewRef = useRef(markdownPreview)
  markdownPreviewRef.current = markdownPreview

  useEffect(() => {
    if (!filePath || !rootPath || diffMode) return
    // Remote/companion files live behind a locator the local root watcher can't
    // match; their changes aren't covered here.
    if (filePath.startsWith('cate-companion://')) return

    const targetPosix = filePath.replace(/\\/g, '/')

    return watchFsRoot(
      rootPath,
      (event) => {
        if (event.type === 'delete') return
        if (event.path.replace(/\\/g, '/') !== targetPosix) return
        // The user's unsaved work wins until they save it themselves.
        if (isDirtyRef.current) return

        window.electronAPI
          .fsReadFile(filePath, workspaceId)
          .then((content) => {
            const model = editorRef.current?.getModel()
            if (!model || model.isDisposed()) return
            // No-op when disk already matches the buffer (e.g. our own save
            // fired the event) — avoids a needless full-model reset.
            if (model.getValue() === content) return
            externalReloadPaths.add(filePath)
            try {
              model.setValue(content)
            } finally {
              externalReloadPaths.delete(filePath)
            }
            if (markdownPreviewRef.current) setMarkdownContent(content)
          })
          .catch(() => { /* file vanished or unreadable — leave the buffer as-is */ })
      },
      workspaceId,
    )
  }, [filePath, rootPath, workspaceId, diffMode])

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
      <div className="flex-1 min-h-0 relative">
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
