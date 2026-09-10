import { useShortcutLabel } from '../stores/shortcutStore'
import { captureEditorPanel } from '../lib/editor/editorDocuments'
import { panelSearchStore } from '../stores/panelSearchStores'
// =============================================================================
// EditorPanel — Monaco Editor wrapper for CanvasIDE editor panels.
// =============================================================================

import { useEffect, useRef, useCallback, useState } from 'react'
import type { ReactNode } from 'react'
import { Check, ChevronDown, ChevronLeft, ChevronRight, Copy, ExternalLink, FolderOpen, Folders, Github, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react'
import { perfCount, useRenderCount } from '../lib/perf/perfClient'
import log from '../lib/logger'
import * as monaco from 'monaco-editor'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { EditorPanelProps } from './types'
import { useAppStore } from '../stores/appStore'
import { useWorktrees } from '../stores/useWorktrees'
import { WorktreeSelector } from '../ui/WorktreeSelector'
import { useSettingsStore } from '../stores/settingsStore'
import { useOptionalCanvasStoreContext } from '../stores/CanvasStoreContext'
import { focusedNodeId } from '../stores/canvas/selectionModel'
import {
  registerEditorSave,
  unregisterEditorSave,
  markEditorActive,
  clearEditorActive,
  getActiveEditorPanelId,
} from '../lib/editor/editorSaveRegistry'
import { getActiveTheme, subscribeTheme } from '../lib/themeManager'
import type { Theme } from '../../shared/types'
import { setPendingReveal, type EditorReveal, takePendingReveal } from '../lib/editor/editorReveal'
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
import { isRuntimeLocator } from '../../shared/runtimeLocator'
import { LoadingState } from '../ui/Spinner'
import { PanelCenteredState } from '../ui/PanelCenteredState'
import { worktreeForPanel, worktreeForPath } from '../lib/worktreeContext'
import { toAbsolutePath, toRelativePath } from '../../shared/pathUtils'
import { FileExplorer } from '../sidebar/FileExplorer'
import { getDocumentType, openFileAsPanel } from '../lib/fs/fileRouting'
import { NodePopover, useNodePopover } from '../ui/Popover'
import { pathDisplayName } from '../lib/fs/displayPath'
import { ExplorerSidebar } from './ExplorerSidebar'
import { SearchView } from '../sidebar/SearchView'
import { useActivePanelStore } from '../lib/activePanel'
import { confirmCloseDirtyPanels } from '../lib/confirmCloseDirty'
import { placementForPanel } from '../lib/workspace/canvasAccess'

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
// EditorPanel component
// -----------------------------------------------------------------------------

export default function EditorPanel({
  panelId,
  workspaceId,
  filePath,
  nodeId,
}: EditorPanelProps) {
  useRenderCount('EditorPanel')
  const shortcutLabel = useShortcutLabel()
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const diffOverlayRef = useRef<HTMLDivElement>(null)

  const [markdownContent, setMarkdownContent] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [fileLoading, setFileLoading] = useState(!!filePath)
  const [editorCollapsed, setEditorCollapsed] = useState(false)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const [toolbarScroll, setToolbarScroll] = useState({ left: false, right: false })
  const [editorBackground, setEditorBackground] = useState(() => getActiveTheme().editor.colors?.['editor.background'] ?? 'var(--surface-1)')
  const openButtonRef = useRef<HTMLButtonElement>(null)
  const [openApps, setOpenApps] = useState<Array<{ id: string; name: string; icon: string }>>([])
  useEffect(() => { void window.electronAPI.shellListApps().then(setOpenApps).catch(() => setOpenApps([])) }, [])
  const openMenu = useNodePopover(openButtonRef, (rect) => ({ left: Math.max(8, Math.min(rect.right - 224, window.innerWidth - 232)), gap: 6, height: 150 }))

  const workspaces = useAppStore((s) => s.workspaces)
  const ws = workspaces.find((w) => w.id === workspaceId)
  const panel = ws?.panels[panelId]
  const worktrees = useWorktrees(ws?.rootPath ?? '', workspaceId)
  const currentWorktree = worktreeForPanel(panel, worktrees)
  const explorerRoot = currentWorktree?.path ?? worktreeForPanel(panel, ws?.worktrees ?? [])?.path ?? ws?.rootPath ?? ''
  const explorerVisible = panel?.sidebarVisible !== false
  const editorVisible = !editorCollapsed || !explorerVisible || !explorerRoot
  const setExplorerVisible = (visible: boolean) => useAppStore.getState().setPanelNavigation(workspaceId, panelId, panel?.sidebarView === 'search' ? 'search' : 'explorer', visible)

  const activePanelId = useActivePanelStore((s) => s.activePanelId)
  const searchVisible = panel?.sidebarView === 'search'
  const searchStore = panelSearchStore(panelId, explorerRoot)
  useEffect(() => {
    const toolbar = toolbarRef.current
    if (!toolbar) return
    const update = () => setToolbarScroll({
      left: toolbar.scrollLeft > 1,
      right: toolbar.scrollLeft + toolbar.clientWidth < toolbar.scrollWidth - 1,
    })
    update()
    toolbar.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(toolbar)
    return () => {
      toolbar.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [filePath, explorerVisible, searchVisible, editorVisible])
  const setNavigationView = (view: 'explorer' | 'search') => {
    useAppStore.getState().setPanelNavigation(workspaceId, panelId, view)
  }


  const showPathMenu = useCallback(async () => {
    if (!filePath) return
    const id = await window.electronAPI.showContextMenu([
      { id: 'absolute', label: 'Copy Absolute Path' },
      { id: 'project', label: 'Copy Path Relative to Project' },
      { id: 'repo', label: 'Copy Path Relative to Repository' },
    ])
    const repoRoot = explorerRoot
    const value = id === 'absolute'
      ? filePath
      : id === 'project'
        ? toRelativePath(filePath, ws?.rootPath ?? '')
        : id === 'repo'
          ? toRelativePath(filePath, repoRoot)
          : null
    if (value) void navigator.clipboard.writeText(value)
  }, [filePath, explorerRoot, ws])

  const runOpenAction = useCallback(async (id: string) => {
    if (!filePath) return
    if (id === 'folder') {
      await window.electronAPI.shellShowInFolder(filePath, workspaceId)
    } else if (id === 'default') {
      const result = await window.electronAPI.shellOpenPath(filePath, workspaceId)
      if (!result.ok) window.alert(result.error ?? 'Could not open this file in another app.')
    } else if (id === 'github') {
      const result = await window.electronAPI.shellOpenFileOnGitHub(filePath, workspaceId)
      if (!result.ok) window.alert('This file is not in a local GitHub repository with an origin remote.')
    }
  }, [filePath, workspaceId])
  // Preview mode is kept per-panel in the store rather than as local state: a
  // single EditorPanel mount is reused across dock tabs (renderPanelComponent
  // creates the element without a key), so local state would leak the toggle
  // from one markdown file to the next. Keying it by panelId also keeps each
  // tab's choice independent across canvas switches.
  const isMarkdown = !!filePath && /\.mdx?$/i.test(filePath)
  const markdownPreview = isMarkdown && (panel?.markdownPreview ?? true)
  const setMarkdownPreview = useCallback(
    (next: boolean) =>
      useAppStore.getState().setPanelMarkdownPreview(workspaceId, panelId, next),
    [workspaceId, panelId],
  )

  // When this panel becomes the focused canvas node, move keyboard focus into
  // the editor so typing works without a second click — matching TerminalPanel
  // and BrowserPanel. (A panel with no CanvasStoreProvider — e.g. docked in a
  // detached window — reads as not-focused.) Retries across a few frames because
  // the Monaco instance is created asynchronously and may not exist yet when
  // focus first lands. Skipped in markdown-preview mode (no text surface).
  const isFocused = useOptionalCanvasStoreContext((s) => focusedNodeId(s) === nodeId, false)
  useEffect(() => {
    if (!isFocused || markdownPreview) return
    let raf = 0
    let tries = 0
    const tryFocus = (): void => {
      const editor = editorRef.current
      if (editor) { editor.focus(); return }
      if (tries++ < 10) raf = requestAnimationFrame(tryFocus)
    }
    raf = requestAnimationFrame(tryFocus)
    return () => cancelAnimationFrame(raf)
  }, [isFocused, markdownPreview])
  // File-backed panels operate on their own checkout. This controls Git diff
  // cwd, file-watch scope, and the default folder for saving an untitled file.
  const checkoutRoot = explorerRoot

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
    rootPath: checkoutRoot,
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

  const switchingFile = useRef(false)
  const openExplorerFiles = useCallback(async (paths: string[], mode?: 'dock' | 'canvas', reveal?: EditorReveal) => {
    if (mode === 'canvas') {
      const placement = placementForPanel(workspaceId, panelId)
      for (const path of paths) openFileAsPanel(workspaceId, path, undefined, placement?.target === 'canvas' ? placement : undefined)
      return
    }
    if (switchingFile.current) return
    const nextPath = paths.find((path) => !getDocumentType(path))
    switchingFile.current = true
    try {
      const store = useAppStore.getState()
      if (nextPath && nextPath !== filePath) {
        const current = store.getWorkspace(workspaceId)?.panels[panelId]
        if (!await confirmCloseDirtyPanels([current], () => sync.discard())) return
        store.setPanelUnsavedContent(workspaceId, panelId, undefined)
        store.setPanelMarkdownPreview(workspaceId, panelId, !reveal && /\.mdx?$/i.test(nextPath))
        if (reveal) setPendingReveal(panelId, reveal)
        store.updatePanelFilePath(workspaceId, panelId, nextPath)
        store.updatePanelTitle(workspaceId, panelId, pathDisplayName(nextPath))
      } else if (nextPath && reveal) {
        store.setPanelMarkdownPreview(workspaceId, panelId, false)
        editorRef.current?.revealLineInCenter(reveal.line)
        editorRef.current?.setPosition({ lineNumber: reveal.line, column: reveal.column ?? 1 })
        editorRef.current?.focus()
      }
      const placement = placementForPanel(workspaceId, panelId)
      let reused = false
      for (const path of paths) {
        if (!reused && path === nextPath) { reused = true; continue }
        openFileAsPanel(workspaceId, path, undefined, placement)
      }
    } catch (error) {
      window.alert(`Could not switch files: ${String(error)}`)
    } finally {
      switchingFile.current = false
    }
  }, [workspaceId, panelId, filePath, sync.discard])

  const switchWorktree = async (worktreeId: string) => {
    const target = worktrees.find((worktree) => worktree.id === worktreeId && !worktree.isOrphan)
    if (!target || target.id === currentWorktree?.id || switchingFile.current) return
    if (filePath) {
      const sourceRoot = worktreeForPath(filePath, worktrees)?.path ?? explorerRoot
      const relativePath = toRelativePath(filePath, sourceRoot)
      if (relativePath === filePath) {
        window.alert('This file is outside the current worktree. Open a file from this project before switching worktrees.')
        return
      }
      const nextPath = toAbsolutePath(relativePath, target.path)
      await openExplorerFiles([nextPath])
      // A cancelled dirty-file prompt must leave both the file and checkout unchanged.
      if (useAppStore.getState().getWorkspace(workspaceId)?.panels[panelId]?.filePath !== nextPath) return
    }
    useAppStore.getState().setPanelWorktreeId(workspaceId, panelId, target.id)
  }

  // ---------------------------------------------------------------------------
  // Mount: create the editor
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!containerRef.current) return
    setLoadError(null)
    setMarkdownContent('')

    applyMonacoTheme(getActiveTheme())
    monaco.editor.setTheme(CATE_MONACO_THEME)
    const fontSize = useSettingsStore.getState().editorFontSize
    const fontFamily = resolveEditorFontFamily(useSettingsStore.getState().editorFontFamily)

    perfCount('editorCreate')
    const editor = monaco.editor.create(containerRef.current, {
      model: null,
      theme: CATE_MONACO_THEME,
      fontFamily,
      fontSize: fontSize || 12,
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
      const fileUri = isRuntimeLocator(filePath)
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
      if (!cached || cached.isDisposed()) {
        const current = useAppStore.getState().workspaces.find(w => w.id === workspaceId)?.panels[panelId]
        const recovered = current ? captureEditorPanel(current) : undefined
        if (recovered?.unsavedContent !== undefined) {
          cached = monaco.editor.createModel(recovered.unsavedContent, detectLanguage(filePath), fileUri)
          rememberModel(filePath, cached)
        }
      }
      if (cached && !cached.isDisposed()) {
        retainModel(filePath)
        modelRetained = true
        editor.setModel(cached)
        if (markdownPreviewRef.current) setMarkdownContent(cached.getValue())
        setFileLoading(false)
        applyPendingReveal()
        // The warm model may be stale: nothing kept it current while this panel
        // was closed. Reconcile with disk — a clean buffer silently catches up, a
        // buffer with unsaved edits raises a conflict instead of being clobbered.
        // (resyncFromDisk recovers the real disk baseline from the model cache.)
        void sync.resyncFromDisk()
      } else {
        setFileLoading(true)
        const language = detectLanguage(filePath)
        const targetPath = filePath
        window.electronAPI
          .fsReadFile(filePath, workspaceId)
          .then((content) => {
            if (cancelled) return
            clearLoadFailed(targetPath)
            setLoadError(null)
            setFileLoading(false)
            // Pass the file URI so Monaco indexes the model by it; this enables
            // monaco.editor.getModel(uri) reuse on later opens. When two panels
            // open the same uncached file concurrently the URI is already taken,
            // so reuse that model instead of letting createModel() throw.
            const recovered = captureEditorPanel(useAppStore.getState().workspaces.find(w => w.id === workspaceId)?.panels[panelId] ?? { id: panelId, type: 'editor', title: 'Untitled', isDirty: false, filePath })
            const model = resolveLoadedModel(
              () => monaco.editor.getModel(fileUri),
              () => monaco.editor.createModel(recovered.unsavedContent ?? content, language, fileUri),
            )
            createdModel = model
            rememberModel(targetPath, model)
            retainModel(targetPath)
            modelRetained = true
            editor.setModel(model)
            if (markdownPreviewRef.current) setMarkdownContent(model.getValue())
            // Freshly read from disk — this is our sync point for the save guard.
            sync.noteLoaded(recovered.editorBaseline ?? content)
            if (recovered.unsavedContent !== undefined) { sync.noteUserEdit(); void sync.resyncFromDisk() }
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
            setFileLoading(false)
            setLoadError(String((err as Error)?.message ?? err))
          })
      }
    } else {
      setFileLoading(false)
      const current = useAppStore.getState().workspaces.find(w => w.id === workspaceId)?.panels[panelId]
      const restored = current ? captureEditorPanel(current).unsavedContent ?? '' : ''
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

    const changeDisposable = editor.onDidChangeModelContent(() => {
      // A disk-driven reload/merge (in useFileSync) replaces the model value;
      // that isn't a user edit, so don't flip the panel to dirty.
      if (sync.isExternalReplace()) return
      sync.noteUserEdit()


    })

    return () => {
      cancelled = true
      layoutObserver.disconnect()
      changeDisposable.dispose()
      focusDisposable.dispose()
      clearEditorActive(panelId)
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
  }, [filePath, workspaceId])

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
      }
      if (state.editorFontFamily !== prevState.editorFontFamily) {
        const fontFamily = resolveEditorFontFamily(state.editorFontFamily)
        editorRef.current?.updateOptions({ fontFamily })
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
      }
    } else {
      // Re-layout Monaco after unhiding — dimensions may have changed while hidden
      editorRef.current?.layout()
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
        verticalScrollbarSize: 13.52,
        horizontalScrollbarSize: 13.52,
        verticalSliderSize: 13.52,
        horizontalSliderSize: 13.52,
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
      setEditorBackground(t.editor.colors?.['editor.background'] ?? 'var(--surface-1)')
      monaco.editor.setTheme(CATE_MONACO_THEME)
    })
    return unsub
  }, [])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="w-full h-full flex flex-col">
      {conflict && (
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
      <div className="relative h-10 shrink-0 border-b border-subtle" style={{ backgroundColor: 'var(--node-chrome-bg, var(--surface-1))' }}>
      <div ref={toolbarRef} className="files-toolbar no-scrollbar h-full overflow-x-auto px-2 flex items-center gap-1 text-xs">
        <button
          onClick={showPathMenu}
          disabled={!filePath}
          className="min-w-0 flex-1 flex items-center gap-1 px-2 py-1 rounded-md text-secondary hover:bg-hover hover:text-primary disabled:opacity-40"
          title={filePath ?? explorerRoot}
        >
          <span className={`${filePath ? 'max-w-[40%]' : ''} truncate text-muted`}>{pathDisplayName(explorerRoot) || 'Files'}</span>
          {filePath && <><ChevronRight size={12} className="shrink-0 text-muted" /><span className="truncate text-primary">{toRelativePath(filePath, explorerRoot)}</span></>}
          <Copy size={12} className="shrink-0" />
          <ChevronDown size={11} className="shrink-0" />
        </button>
        <div className="shrink-0 max-w-40">
          <WorktreeSelector worktrees={worktrees} value={currentWorktree?.id} onChange={switchWorktree} title="File panel worktree" />
        </div>
        {isMarkdown && (
          <button
            onClick={() => setMarkdownPreview(!markdownPreview)}
            className={`shrink-0 px-2 py-1 rounded-md text-xs font-medium transition-colors ${
              markdownPreview
                ? 'bg-agent/15 text-agent hover:bg-agent/25'
                : 'bg-surface-3 text-secondary hover:bg-surface-4 hover:text-primary'
            }`}
            title={markdownPreview ? 'Show source' : 'Preview markdown'}
          >
            {markdownPreview ? 'Source' : 'Preview'}
          </button>
        )}
        <button
          onClick={async () => {
            if (!filePath) return
            const result = await window.electronAPI.shellOpenFileOnGitHub(filePath, workspaceId)
            if (!result.ok) window.alert('This file is not in a local GitHub repository with an origin remote.')
          }}
          disabled={!filePath}
          className="shrink-0 p-1.5 rounded-md text-secondary hover:bg-hover hover:text-primary disabled:opacity-40"
          title="Open on GitHub"
        ><Github size={14} /></button>
        <button
          ref={openButtonRef}
          onClick={() => openMenu.setOpen(!openMenu.open)}
          aria-expanded={openMenu.open}
          disabled={!filePath}
          className="shrink-0 flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-strong text-secondary hover:bg-hover hover:text-primary disabled:opacity-40"
          title="Open in another app"
        ><ExternalLink size={13} /><span>Open</span><ChevronDown size={11} /></button>
        <button
          onClick={() => {
            if (editorVisible) setExplorerVisible(true)
            setEditorCollapsed(editorVisible)
          }}
          disabled={!explorerRoot}
          className="shrink-0 p-1.5 rounded-md text-secondary hover:bg-hover hover:text-primary disabled:opacity-40"
          title={editorVisible ? 'Show sidebar only' : 'Show editor'}
          aria-label={editorVisible ? 'Show sidebar only' : 'Show editor'}
          aria-pressed={!editorVisible}
        >{editorVisible ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}</button>
        <button
          onClick={() => {
            if (explorerVisible && !searchVisible) setExplorerVisible(false)
            else setNavigationView('explorer')
          }}
          disabled={!explorerRoot}
          className={`shrink-0 p-1.5 rounded-md hover:bg-hover disabled:opacity-40 ${explorerVisible && !searchVisible ? 'text-primary bg-surface-3' : 'text-secondary'}`}
          title={shortcutLabel('toggleFileExplorer', explorerVisible && !searchVisible ? 'Hide files' : 'Show files')}
          aria-label="Files sidebar"
          aria-pressed={explorerVisible && !searchVisible}
        ><Folders size={15} /></button>
        <button
          onClick={() => {
            if (explorerVisible && searchVisible) setExplorerVisible(false)
            else setNavigationView('search')
          }}
          disabled={!explorerRoot}
          className={`shrink-0 p-1.5 rounded-md hover:bg-hover disabled:opacity-40 ${explorerVisible && searchVisible ? 'text-primary bg-surface-3' : 'text-secondary'}`}
          title={shortcutLabel('toggleSearch', explorerVisible && searchVisible ? 'Hide search' : 'Search in files')}
          aria-label="Search sidebar"
          aria-pressed={explorerVisible && searchVisible}
        ><Search size={15} /></button>
      </div>
      {toolbarScroll.left && (
        <button
          onClick={() => toolbarRef.current?.scrollBy({ left: -180, behavior: 'smooth' })}
          className="absolute inset-y-0 left-0 z-10 flex w-8 items-center justify-start bg-gradient-to-r from-surface-1 via-surface-1/90 to-transparent pl-1 text-secondary hover:text-primary"
          aria-label="Scroll toolbar left"
        ><ChevronLeft size={16} className="animate-pulse" /></button>
      )}
      {toolbarScroll.right && (
        <button
          onClick={() => toolbarRef.current?.scrollBy({ left: 180, behavior: 'smooth' })}
          className="absolute inset-y-0 right-0 z-10 flex w-8 items-center justify-end bg-gradient-to-l from-surface-1 via-surface-1/90 to-transparent pr-1 text-secondary hover:text-primary"
          aria-label="Scroll toolbar right"
        ><ChevronRight size={16} className="animate-pulse" /></button>
      )}
      </div>
      {openMenu.open && <NodePopover popoverRef={openMenu.popoverRef} pos={openMenu.pos} portalTarget={openMenu.portalTarget} width={224} bodyClassName="p-1.5 !rounded-2xl !border-subtle !bg-surface-3 !shadow-lg">
        <div onKeyDown={(event) => event.stopPropagation()} className="flex flex-col gap-0.5">
          {openApps.map((application) => <button key={application.id} onClick={() => {
            openMenu.setOpen(false)
            if (filePath) void window.electronAPI.shellOpenPath(filePath, workspaceId, application.id).then((result) => {
              if (!result.ok) window.alert(result.error)
            }).catch((error) => window.alert(String(error)))
          }} className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-primary hover:bg-hover">
            {application.icon ? <img src={application.icon} alt="" className="w-4 h-4 object-contain" /> : <ExternalLink size={16} />}{application.name}
          </button>)}
          {openApps.length > 0 && <div className="my-1 border-t border-subtle" />}
          {([
            ['default', 'Open in Default App', ExternalLink],
            ['folder', 'Show in File Explorer', Folders],
            ['github', 'Open on GitHub', Github],
          ] as const).map(([id, label, Icon]) => <button key={id} onClick={() => {
            openMenu.setOpen(false)
            openButtonRef.current?.focus()
            void runOpenAction(id).catch((error) => window.alert(String(error)))
          }} className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-primary hover:bg-hover focus-visible:bg-hover"><Icon size={16} className="text-muted" />{label}</button>)}
        </div>
      </NodePopover>}
      <div className="files-content flex-1 min-h-0 flex" style={{ backgroundColor: editorBackground }}>
      <div className={`${editorVisible ? 'flex-1' : 'hidden'} min-w-0 relative`}>
        {showDiff && conflict?.kind === 'changed' && (
          <div className="absolute inset-0 z-30 bg-surface-1">
            <div ref={diffOverlayRef} className="w-full h-full" />
          </div>
        )}
        {markdownPreview && isMarkdown && (
          <MarkdownPreview content={markdownContent} />
        )}
        {loadError && (
          <PanelCenteredState
            className="absolute inset-0 z-20 bg-surface-1 px-6"
            title={/ENOENT|no such file/i.test(loadError) ? 'File not found in this worktree' : 'Couldn’t open this file'}
            description={<span className="break-all text-secondary">{/ENOENT|no such file/i.test(loadError)
              ? `${filePath ? toRelativePath(filePath, explorerRoot) : 'This file'} is not present here. Choose another worktree or open a file from Files.`
              : loadError}</span>}
          />
        )}
        {fileLoading && (
          <LoadingState label="Loading file…" className="absolute inset-0 z-20 bg-surface-1 text-sm" />
        )}
        <div ref={containerRef} className={`w-full h-full ${(markdownPreview && isMarkdown) || loadError ? 'hidden' : ''}`} />

      </div>
      {explorerRoot && (
        <ExplorerSidebar visible={explorerVisible} fill={!editorVisible} onHide={() => setExplorerVisible(false)}>
          {searchVisible
            ? <SearchView store={searchStore} panelId={panelId} focusToken={panel?.navigationEpoch} rootPath={explorerRoot} workspaceId={workspaceId} focusInput={explorerVisible && activePanelId === panelId} onOpenMatch={(path, line, column) => { void openExplorerFiles([path], 'dock', { line, column }) }} />
            : <FileExplorer workspaceId={workspaceId} panelId={panelId} rootPath={explorerRoot} onOpenFiles={openExplorerFiles} compact />}
        </ExplorerSidebar>
      )}
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
          className={`absolute top-1.5 right-1.5 p-1 rounded-[10px] bg-surface-3 text-muted transition-opacity hover:text-primary hover:bg-hover-strong ${
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
      <div className="max-w-3xl mx-auto prose-markdown space-y-3 [&>:first-child]:mt-0 text-[13px] text-primary leading-relaxed">
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
