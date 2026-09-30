// The canvas actions: zoom, navigation, panning, arrangement, tools, the
// minimap and the canvas toolbar's menus, on the canvas the window's focus
// is on (activeCanvasId). Also the raw canvas keys that are not shortcut
// actions: Space for the hand tool, Cmd+A, Escape, Delete and Enter.

import type { ShortcutAction } from '@kernel/ui/contract'
import { tryRuntimeFor } from '@kernel/rpc/client'
import { clientStateFor, documentStoreFor } from '@client/document'
import { closePanel, focusPanel } from '@client/host'
import {
  activeCanvasId,
  activeNodePanelId,
  canvasViewFor,
  focusedNodeId,
  requestCanvasToolbarAction,
  useCanvasUi,
  type CanvasToolbarAction,
  type CanvasViewStore,
} from '@client/layout/canvas'
import { canvasPanelOf } from '@workspace/document/contract'
import { useUIStore } from '../state/uiStore'
import { bindActions, type ActionBinding } from './registry'
import { registerKeyHandler, type KeyContext } from './useShortcuts'

const ZOOM_STEP = 0.1

interface ActiveCanvas {
  workspaceId: string
  canvasId: string
  store: CanvasViewStore
}

function activeCanvas(workspaceId: string | null = useUIStore.getState().selectedWorkspaceId): ActiveCanvas | null {
  if (!workspaceId) return null
  const canvasId = activeCanvasId(workspaceId)
  const store = canvasId ? canvasViewFor(workspaceId, canvasId) : null
  return canvasId && store ? { workspaceId, canvasId, store } : null
}

const canvasPanelIdOf = (canvas: ActiveCanvas): string | null => {
  const doc = documentStoreFor(canvas.workspaceId)?.getSnapshot()
  return doc ? canvasPanelOf(doc, canvas.canvasId)?.id ?? null : null
}

/** An action on the active canvas's view store; hidden without a canvas. */
function onCanvas(run: (canvas: ActiveCanvas) => void | Promise<void>, inPalette = true): ActionBinding {
  return {
    run: ({ workspaceId }) => {
      const canvas = activeCanvas(workspaceId)
      if (canvas) return run(canvas)
    },
    enabled: () => !!activeCanvas(),
    inPalette,
  }
}

function toolbar(action: CanvasToolbarAction): ActionBinding {
  return onCanvas((canvas) => {
    const panelId = canvasPanelIdOf(canvas)
    if (panelId) requestCanvasToolbarAction(action, panelId)
  })
}

const navigate = (dir: 'up' | 'down' | 'left' | 'right'): ActionBinding => onCanvas((canvas) => {
  // Release the source surface so jumps chain and Enter activates.
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  const panelId = canvasPanelIdOf(canvas)
  if (panelId) focusPanel(canvas.workspaceId, panelId)
  canvas.store.getState().navigateSelect(dir)
}, false)

const pan = (dir: 'up' | 'down' | 'left' | 'right'): ActionBinding =>
  onCanvas((canvas) => canvas.store.getState().panViewport(dir), false)

/** The shown panel of the canvas's focused node. */
function focusedNodePanel(canvas: ActiveCanvas): string | null {
  const state = canvas.store.getState()
  const nodeId = focusedNodeId(state)
  const node = nodeId ? state.nodes[nodeId] : undefined
  if (!node) return null
  return activeNodePanelId(node.dock, clientStateFor(canvas.workspaceId)?.getSnapshot().activeTabs) ?? null
}

async function toggleKeepAwake(workspaceId: string | null): Promise<void> {
  const power = workspaceId ? tryRuntimeFor(workspaceId)?.power : undefined
  if (!power) return
  const state = await power.get()
  await power.set({ duration: state.requested ? false : null })
}

const setTool = (tool: 'select' | 'hand') => () => useCanvasUi.getState().setActiveTool(tool)

export function canvasActionBindings(): Partial<Record<ShortcutAction, ActionBinding>> {
  return {
    zoomIn: onCanvas(({ store }) => { const s = store.getState(); s.animateZoomTo(s.zoomLevel + ZOOM_STEP) }),
    zoomOut: onCanvas(({ store }) => { const s = store.getState(); s.animateZoomTo(s.zoomLevel - ZOOM_STEP) }),
    zoomReset: onCanvas(({ store }) => store.getState().animateZoomTo(1)),
    zoomToFit: onCanvas(({ store }) => store.getState().zoomToFit()),
    zoomToSelection: onCanvas(({ store }) => store.getState().zoomToSelection()),
    focusNext: onCanvas(({ store }) => { const s = store.getState(); const next = s.nextNode(); if (next) s.focusNode(next) }),
    focusPrevious: onCanvas(({ store }) => { const s = store.getState(); const prev = s.previousNode(); if (prev) s.focusNode(prev) }),
    autoLayout: onCanvas(({ store }) => store.getState().autoLayout()),
    tidyGrid: onCanvas(({ store }) => store.getState().tidyGridSelected()),
    navigateUp: navigate('up'),
    navigateDown: navigate('down'),
    navigateLeft: navigate('left'),
    navigateRight: navigate('right'),
    panUp: pan('up'),
    panDown: pan('down'),
    panLeft: pan('left'),
    panRight: pan('right'),
    deleteNode: onCanvas(async (canvas) => {
      const panelId = focusedNodePanel(canvas)
      if (panelId) await closePanel(canvas.workspaceId, panelId)
    }),
    toggleMinimap: onCanvas(({ canvasId }) => useCanvasUi.getState().toggleMinimap(canvasId)),
    toggleTool: { run: () => { const ui = useCanvasUi.getState(); ui.setActiveTool(ui.activeTool === 'hand' ? 'select' : 'hand') } },
    selectTool: { run: setTool('select') },
    handTool: { run: setTool('hand') },
    openWorktreeMenu: toolbar('openWorktreeMenu'),
    openConversationMenu: toolbar('openConversationMenu'),
    toggleCanvasToolbar: toolbar('toggleCanvasToolbar'),
    toggleKeepAwake: {
      run: ({ workspaceId }) => toggleKeepAwake(workspaceId),
      enabled: () => { const ws = useUIStore.getState().selectedWorkspaceId; return !!ws && !!tryRuntimeFor(ws)?.power },
    },
  }
}

const plain = (e: KeyboardEvent) => !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey

/** Focus is in a list that handles its own keys. */
const ownKeys = () => !!(document.activeElement as HTMLElement | null)?.closest('[data-keynav], [data-sidebar-keynav]')

/** Raw canvas keys; Returns true when handled. */
export function handleCanvasKey(e: KeyboardEvent, ctx: KeyContext): boolean {
  if (ctx.overlayOpen || ctx.keyboardOwned) return false
  if (e.code === 'Space' && plain(e)) {
    if (ctx.textSurface) return false
    if (!e.repeat) setTool(useCanvasUi.getState().activeTool === 'hand' ? 'select' : 'hand')()
    return true
  }
  if (e.key === 'Escape') {
    if (ctx.textSurface) return false
    activeCanvas()?.store.getState().clearSelection()
    if (useCanvasUi.getState().activeTool !== 'select') setTool('select')()
    // Escape may close other things too; do not stop it.
    return false
  }
  if (ctx.textSurface || ownKeys()) return false
  const canvas = activeCanvas()
  if (!canvas) return false
  const state = canvas.store.getState()
  if (e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.key === 'a') {
    state.selectAll()
    return true
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && !e.metaKey && state.selection.length > 0) {
    void state.deleteSelection()
    return true
  }
  if (e.key === 'Enter' && plain(e) && state.selection.length === 1) {
    const id = state.selection[0]
    if (id === focusedNodeId(state) || !state.nodes[id]) return false
    state.focusNode(id)
    return true
  }
  return false
}

export function registerCanvasActions(): () => void {
  const offActions = bindActions(canvasActionBindings())
  const offKeys = registerKeyHandler(handleCanvasKey)
  return () => { offActions(); offKeys() }
}
