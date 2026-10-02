// Client state of one workspace (section 5): what this client shows and
// where its attention is. Held in memory, never sent to the runtime, except
// the viewed and focused panel, which presence reports.

import type { CanvasId, NodeId, PanelId, StackId } from '@workspace/document/contract'

export interface Viewport {
  x: number
  y: number
  zoom: number
}

/** Something a panel view should do once when it next looks (reveal a line,
 *  focus the input). Taken, not read. */
export interface Intent {
  id: number
  panelId: PanelId
  kind: string
  data?: unknown
}

export interface ClientState {
  /** Which tab each stack shows. A stack without an entry shows its first. */
  activeTabs: Readonly<Record<StackId, PanelId>>
  focusedPanelId: PanelId | null
  /** Increases on every focus call, so re-focusing the same panel is visible. */
  focusEpoch: number
  /** The panels this client shows (presence). */
  viewing: readonly PanelId[]
  selection: Readonly<Record<CanvasId, readonly NodeId[]>>
  viewports: Readonly<Record<CanvasId, Viewport>>
  /** What this client shows of each panel (the browser tab it shows, the
   *  review files it collapsed), by panel and name. */
  panelViews: Readonly<Record<PanelId, Readonly<Record<string, unknown>>>>
  intents: readonly Intent[]
}

export interface ClientStateStore {
  getSnapshot(): ClientState
  subscribe(listener: () => void): () => void
  setActiveTab(stackId: StackId, panelId: PanelId): void
  focus(panelId: PanelId | null): void
  setViewing(panelIds: readonly PanelId[]): void
  setSelection(canvasId: CanvasId, nodeIds: readonly NodeId[]): void
  setViewport(canvasId: CanvasId, viewport: Viewport): void
  setPanelView(panelId: PanelId, key: string, value: unknown): void
  /** Queues an intent; returns its id. */
  pushIntent(intent: Omit<Intent, 'id'>): number
  /** Removes and returns the panel's queued intents. */
  takeIntents(panelId: PanelId): Intent[]
}

export function createClientStateStore(): ClientStateStore {
  let state: ClientState = {
    activeTabs: {},
    focusedPanelId: null,
    focusEpoch: 0,
    viewing: [],
    selection: {},
    viewports: {},
    panelViews: {},
    intents: [],
  }
  let nextIntent = 1
  const listeners = new Set<() => void>()

  const update = (patch: Partial<ClientState>) => {
    state = { ...state, ...patch }
    for (const listener of [...listeners]) {
      try { listener() } catch { /* isolate listeners */ }
    }
  }

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    setActiveTab(stackId, panelId) {
      if (state.activeTabs[stackId] === panelId) return
      update({ activeTabs: { ...state.activeTabs, [stackId]: panelId } })
    },
    focus(panelId) {
      update({ focusedPanelId: panelId, focusEpoch: state.focusEpoch + 1 })
    },
    setViewing(panelIds) {
      if (panelIds.length === state.viewing.length && panelIds.every((id, i) => id === state.viewing[i])) return
      update({ viewing: [...panelIds] })
    },
    setSelection(canvasId, nodeIds) {
      update({ selection: { ...state.selection, [canvasId]: [...nodeIds] } })
    },
    setViewport(canvasId, viewport) {
      update({ viewports: { ...state.viewports, [canvasId]: { ...viewport } } })
    },
    setPanelView(panelId, key, value) {
      const view = state.panelViews[panelId]
      if (view && Object.is(view[key], value)) return
      update({ panelViews: { ...state.panelViews, [panelId]: { ...view, [key]: value } } })
    },
    pushIntent(intent) {
      const id = nextIntent++
      update({ intents: [...state.intents, { ...intent, id }] })
      return id
    },
    takeIntents(panelId) {
      const taken = state.intents.filter((i) => i.panelId === panelId)
      if (taken.length > 0) update({ intents: state.intents.filter((i) => i.panelId !== panelId) })
      return taken
    },
  }
}
