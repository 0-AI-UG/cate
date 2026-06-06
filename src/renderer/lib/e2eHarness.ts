// E2E test harness — exposes a tiny inspect/seed API on window.__cateE2E
// when the app is launched with CATE_E2E=1.
//
// Why a harness: drag tests need deterministic seed (1-2 nodes at known
// positions, known zoom) and assertions against canvas-space state. Driving
// the UI for setup is brittle; reaching into stores is reliable.

import { useAppStore } from '../stores/appStore'
import { useUIStore, type SidebarView } from '../stores/uiStore'
import { getOrCreateCanvasStoreForPanel } from '../stores/canvasStore'
import { useDragStore } from '../drag/store'
import { useSearchStore } from '../stores/searchStore'
import { getLastReveal } from './editor/editorReveal'
import { applyTheme } from './themeManager'
import { BUILT_IN_THEMES } from '../../shared/themes'
import { terminalRegistry } from './terminal/terminalRegistry'
import type { Point } from '../../shared/types'

/** Serializable snapshot of the search store for e2e assertions. */
export interface SearchSnapshot {
  query: string
  isRegex: boolean
  matchCase: boolean
  wholeWord: boolean
  includes: string
  excludes: string
  respectIgnore: boolean
  optionsExpanded: boolean
  status: string
  searchId: string | null
  truncated: boolean
  error: string | null
  fileCount: number
  filePaths: string[]
  totalMatches: number
  dismissedFiles: number
  dismissedLines: number
}

declare global {
  interface Window {
    __cateE2E?: {
      ready: true
      activeCanvasPanelId(): string | null
      createTerminal(point: Point): string
      createEditor(point: Point): string
      createCanvasPanel(point: Point): string
      nodes(): { id: string; panelId: string; origin: Point; size: { width: number; height: number } }[]
      zoom(): number
      setZoom(z: number): void
      resetViewport(): void
      addWorkspace(name?: string, rootPath?: string, id?: string): string
      selectWorkspace(id: string): Promise<void>
      /** Resolve the PTY id backing a terminal node (null until the PTY spawns). */
      terminalPtyId(nodeId: string): string | null
      /** Write raw data to a terminal node's PTY (e.g. a flooding command). */
      writeTerminal(nodeId: string, data: string): boolean
      /** Point the selected workspace at a real directory (registers it as an
       *  allowed root) so content search has files to scan. */
      setWorkspaceRoot(rootPath: string): Promise<boolean>
      /** Activate a sidebar view (e.g. 'search') on the left activity bar. */
      openSidebarView(view: SidebarView): void
      /** Set (or clear, with null) the active left sidebar view. Passing null
       *  collapses the sidebar panel — used by canvas geometry tests that need
       *  the full-width canvas the pushed sidebar would otherwise shrink. */
      setActiveLeftSidebarView(view: SidebarView | null): void
      /** File paths of currently-open editor panels (for open-at-match asserts). */
      editorPaths(): string[]
      /** Serializable snapshot of the search store (query, options, results). */
      getSearchSnapshot(): SearchSnapshot
      /** The most recent editor reveal request (panelId + line/column), or null. */
      lastEditorReveal(): { panelId: string; line: number; column?: number } | null
      /** Apply a theme by id (for cross-theme visual checks). */
      setTheme(id: string): void
      /** All available theme ids + their light/dark type. */
      themeIds(): { id: string; type: string }[]
      dragSnapshot(): {
        isDragging: boolean
        sourceKind: string | null
        sourceNodeId: string | null
        targetKind: string | null
      }
    }
  }
}

export function installE2EHarness(): void {
  if (window.__cateE2E) return

  // Kill CSS transitions/animations under e2e. The windows are hidden (main's
  // revealWindow is a no-op under CATE_E2E), and a hidden window throttles the
  // compositor — so anything animated over time (node enter/exit, drag opacity,
  // layout) would otherwise leave the timing-sensitive specs reading a
  // mid-animation rect. Making every transition instant keeps geometry/visual
  // state final the moment it changes. (Node enter/exit state is also forced to
  // its final value at the source — see canvasStore/CanvasNode — since those are
  // rAF/timer driven, not pure CSS.)
  const noAnim = document.createElement('style')
  noAnim.setAttribute('data-cate-e2e-no-animations', '')
  noAnim.textContent =
    '*, *::before, *::after { transition-duration: 0s !important; transition-delay: 0s !important; animation-duration: 0s !important; animation-delay: 0s !important; }'
  document.head.appendChild(noAnim)

  // The Canvas component stamps data-canvas-panel-id on its root — use the
  // DOM as the source of truth for which canvas is currently mounted/active.
  const activeCanvasPanelId = (): string | null => {
    const el = document.querySelector('[data-canvas-panel-id]')
    return el?.getAttribute('data-canvas-panel-id') ?? null
  }

  const activeCanvasStore = () => {
    const pid = activeCanvasPanelId()
    return pid ? getOrCreateCanvasStoreForPanel(pid) : null
  }

  const createTerminal = (point: Point): string => {
    const wsId = useAppStore.getState().selectedWorkspaceId
    const panelId = useAppStore.getState().createTerminal(wsId, undefined, point)
    const cs = activeCanvasStore()
    if (!cs) return panelId
    for (const n of Object.values(cs.getState().nodes)) {
      if (n.panelId === panelId) return n.id
    }
    return panelId
  }

  const createEditor = (point: Point): string => {
    const wsId = useAppStore.getState().selectedWorkspaceId
    const panelId = useAppStore.getState().createEditor(wsId, undefined, point)
    const cs = activeCanvasStore()
    if (!cs) return panelId
    for (const n of Object.values(cs.getState().nodes)) {
      if (n.panelId === panelId) return n.id
    }
    return panelId
  }

  const createCanvasPanel = (point: Point): string => {
    const wsId = useAppStore.getState().selectedWorkspaceId
    useAppStore.getState().createCanvas(wsId, point)
    const cs = activeCanvasStore()
    if (!cs) return ''
    const nodes = Object.values(cs.getState().nodes)
    return nodes.length ? nodes[nodes.length - 1].id : ''
  }

  const nodes = () => {
    const cs = activeCanvasStore()
    if (!cs) return []
    return Object.values(cs.getState().nodes).map((n) => ({
      id: n.id,
      panelId: n.panelId,
      origin: { x: n.origin.x, y: n.origin.y },
      size: { width: n.size.width, height: n.size.height },
    }))
  }

  const zoom = () => activeCanvasStore()?.getState().zoomLevel ?? 1

  const setZoom = (z: number) => {
    activeCanvasStore()?.getState().setZoom(z)
  }

  const resetViewport = () => {
    activeCanvasStore()?.setState({ viewportOffset: { x: 0, y: 0 } })
  }

  const addWorkspace = (name?: string, rootPath?: string, id?: string): string => {
    return useAppStore.getState().addWorkspace(name, rootPath, id)
  }

  const selectWorkspace = async (id: string): Promise<void> => {
    await useAppStore.getState().selectWorkspace(id)
  }

  const terminalPtyId = (nodeId: string): string | null => {
    const cs = activeCanvasStore()
    if (!cs) return null
    const node = cs.getState().nodes[nodeId]
    const panelId = node?.panelId ?? nodeId
    return terminalRegistry.getEntry(panelId)?.ptyId || null
  }

  const writeTerminal = (nodeId: string, data: string): boolean => {
    const ptyId = terminalPtyId(nodeId)
    if (!ptyId) return false
    void window.electronAPI?.terminalWrite(ptyId, data)
    return true
  }

  const setWorkspaceRoot = (rootPath: string): Promise<boolean> => {
    const wsId = useAppStore.getState().selectedWorkspaceId
    return useAppStore.getState().setWorkspaceRootPath(wsId, rootPath)
  }

  const setActiveLeftSidebarView = (view: SidebarView | null): void => {
    useUIStore.getState().setActiveLeftSidebarView(view)
  }

  const openSidebarView = (view: SidebarView): void => {
    useUIStore.getState().setActiveLeftSidebarView(view)
  }

  const editorPaths = (): string[] => {
    const s = useAppStore.getState()
    const ws = s.workspaces.find((w) => w.id === s.selectedWorkspaceId)
    if (!ws) return []
    return Object.values(ws.panels)
      .filter((p) => p.type === 'editor' && !!p.filePath)
      .map((p) => p.filePath as string)
  }

  const getSearchSnapshot = (): SearchSnapshot => {
    const s = useSearchStore.getState()
    return {
      query: s.query,
      isRegex: s.isRegex,
      matchCase: s.matchCase,
      wholeWord: s.wholeWord,
      includes: s.includes,
      excludes: s.excludes,
      respectIgnore: s.respectIgnore,
      optionsExpanded: s.optionsExpanded,
      status: s.status,
      searchId: s.currentSearchId,
      truncated: s.truncated,
      error: s.error,
      fileCount: s.files.length,
      filePaths: s.files.map((f) => f.relativePath),
      totalMatches: s.files.reduce((n, f) => n + f.matchCount, 0),
      dismissedFiles: s.dismissedFiles.size,
      dismissedLines: s.dismissedLines.size,
    }
  }

  const lastEditorReveal = () => getLastReveal()

  const setTheme = (id: string): void => applyTheme(id)
  const themeIds = (): { id: string; type: string }[] =>
    BUILT_IN_THEMES.map((t) => ({ id: t.id, type: t.type }))

  const dragSnapshot = () => {
    const s = useDragStore.getState()
    return {
      isDragging: s.isDragging,
      sourceKind: s.source?.origin.kind ?? null,
      sourceNodeId:
        s.source?.origin.kind === 'canvas-node' ? s.source.origin.nodeId : null,
      targetKind: s.target?.kind ?? null,
    }
  }

  window.__cateE2E = {
    ready: true,
    activeCanvasPanelId,
    createTerminal,
    createEditor,
    createCanvasPanel,
    nodes,
    zoom,
    setZoom,
    resetViewport,
    addWorkspace,
    selectWorkspace,
    terminalPtyId,
    writeTerminal,
    setWorkspaceRoot,
    openSidebarView,
    setActiveLeftSidebarView,
    editorPaths,
    getSearchSnapshot,
    lastEditorReveal,
    setTheme,
    themeIds,
    dragSnapshot,
  }
}
