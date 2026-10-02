// The canvas actions: zoom, navigation, panning, arrangement, tools, the
// minimap and the canvas toolbar's menus, on the canvas a request names (its
// context menu) or else the one the window's focus is on (activeCanvasId). Also the raw canvas keys that are not shortcut
// actions: Space for the hand tool, Cmd+A, Escape, Delete and Enter.

import { defineActions, storedShortcut } from '@kernel/ui/contract'
import { tryRuntimeFor } from '@kernel/rpc/client'
import { clientStateFor, documentStoreFor } from '@client/document'
import { closePanel, focusPanel, registerActions, type ActionBinding, type ActionContext } from '@client/host'
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
import { registerKeyHandler, type KeyContext } from './useShortcuts'

const ZOOM_STEP = 0.1
const key = storedShortcut
const arrows = { yieldToOverlay: true } as const
const pans = { yieldToOverlay: true, yieldToText: true, windowOnly: true } as const

export const CANVAS_ACTIONS = defineActions({
  zoomIn: { title: 'Zoom In', key: key('=', { command: true }), aliasKeys: [key('=', { command: true, shift: true }), key('+', { command: true })], menu: { bar: 'view', group: 'zoom', order: 0 } },
  zoomOut: { title: 'Zoom Out', key: key('-', { command: true }), menu: { bar: 'view', group: 'zoom', order: 1 } },
  zoomReset: { title: 'Reset Zoom', key: key('0', { command: true }), welcome: true, menu: { bar: 'view', group: 'zoom', order: 2 } },
  zoomToFit: { title: 'Zoom to Fit', key: key('1', { command: true }), menu: { bar: 'view', group: 'zoom', order: 3 }, contextMenus: ['canvas'] },
  zoomToSelection: { title: 'Zoom to Selection', key: key('2', { command: true }) },
  focusNext: { title: 'Next Panel', key: key('\t', { control: true }), menu: { bar: 'go', group: 'panels', order: 0 } },
  focusPrevious: { title: 'Previous Panel', key: key('\t', { shift: true, control: true }), menu: { bar: 'go', group: 'panels', order: 1 } },
  autoLayout: { title: 'Auto Layout Canvas', key: key('l', { command: true, shift: true }), contextMenus: ['canvas'] },
  tidyGrid: { title: 'Tidy Selected Panels into Grid', key: key('g', { command: true }), keys: { yieldToText: true, yieldToKeyboardOwner: true, yieldToOverlay: true, windowOnly: true } },
  navigateUp: { title: 'Navigate to Panel Above', key: key('↑', { command: true }), palette: false, keys: { ...arrows, fromGuests: true } },
  navigateDown: { title: 'Navigate to Panel Below', key: key('↓', { command: true }), palette: false, keys: { ...arrows, fromGuests: true } },
  navigateLeft: { title: 'Navigate to Panel Left', key: key('←', { command: true }), palette: false, keys: { ...arrows, fromGuests: true } },
  navigateRight: { title: 'Navigate to Panel Right', key: key('→', { command: true }), palette: false, keys: { ...arrows, fromGuests: true } },
  panUp: { title: 'Pan Canvas Up', key: key('↑', { shift: true }), palette: false, keys: pans },
  panDown: { title: 'Pan Canvas Down', key: key('↓', { shift: true }), palette: false, keys: pans },
  panLeft: { title: 'Pan Canvas Left', key: key('←', { shift: true }), palette: false, keys: pans },
  panRight: { title: 'Pan Canvas Right', key: key('→', { shift: true }), palette: false, keys: pans },
  deleteNode: { title: 'Delete Focused Panel', key: key('Backspace', { command: true }), keys: { yieldToText: true, yieldToKeyboardOwner: true, yieldToList: true, windowOnly: true } },
  toggleMinimap: { title: 'Toggle Minimap', key: key('m', { command: true, shift: true }), menu: { bar: 'view', group: 'panes' } },
  // Control+Space is safe while typing; Shift+Space used to swallow ordinary spaces.
  toggleTool: { title: 'Toggle Select / Hand Tool', key: key(' ', { control: true }), keys: { noRepeat: true } },
  selectTool: { title: 'Select Tool', key: key('1', { command: true, option: true }) },
  handTool: { title: 'Hand Tool', key: key('2', { command: true, option: true }) },
  openWorktreeMenu: { title: 'Parallel Worktrees', key: key('w', { command: true, option: true }), keys: { noRepeat: true } },
  openConversationMenu: { title: 'T3 Code Conversations', key: key('a', { command: true, option: true }), keys: { noRepeat: true } },
  toggleCanvasToolbar: { title: 'Expand / Collapse Canvas Toolbar', key: key('b', { command: true, option: true }), keys: { noRepeat: true } },
  toggleKeepAwake: { title: 'Toggle Keep Awake', key: key('k', { command: true, option: true }), keys: { noRepeat: true } },
})

interface ActiveCanvas {
  workspaceId: string
  canvasId: string
  store: CanvasViewStore
}

/** The canvas a request names (its context menu), else the window's active
 *  one. */
function activeCanvas(context: ActionContext = { workspaceId: useUIStore.getState().selectedWorkspaceId }): ActiveCanvas | null {
  const { workspaceId } = context
  if (!workspaceId) return null
  const canvasId = context.canvasId ?? activeCanvasId(workspaceId)
  const store = canvasId ? canvasViewFor(workspaceId, canvasId) : null
  return canvasId && store ? { workspaceId, canvasId, store } : null
}

const canvasPanelIdOf = (canvas: ActiveCanvas): string | null => {
  const doc = documentStoreFor(canvas.workspaceId)?.getSnapshot()
  return doc ? canvasPanelOf(doc, canvas.canvasId)?.id ?? null : null
}

/** An action on the active canvas's view store; hidden without a canvas. */
function onCanvas(run: (canvas: ActiveCanvas) => void | Promise<void>): ActionBinding {
  return {
    run: (context) => {
      const canvas = activeCanvas(context)
      if (canvas) return run(canvas)
    },
    enabled: (context) => !!activeCanvas(context),
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
})

const pan = (dir: 'up' | 'down' | 'left' | 'right'): ActionBinding =>
  onCanvas((canvas) => canvas.store.getState().panViewport(dir))

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

export function canvasActionBindings(): { [K in keyof typeof CANVAS_ACTIONS]: ActionBinding } {
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
      enabled: ({ workspaceId }) => !!workspaceId && !!tryRuntimeFor(workspaceId)?.power,
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
  const offActions = registerActions(CANVAS_ACTIONS, canvasActionBindings())
  const offKeys = registerKeyHandler(handleCanvasKey)
  return () => { offActions(); offKeys() }
}
