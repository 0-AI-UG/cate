// =============================================================================
// Canvas Store — Zustand state for canvas nodes, viewport, and zoom.
// Ported from CanvasState.swift
// =============================================================================

import { create, type UseBoundStore } from 'zustand'
import { useStoreWithEqualityFn } from 'zustand/traditional'
import type { StoreApi } from 'zustand'
import type {
  CanvasNodeId,
  CanvasNodeState,
  CanvasAnnotation,
  CanvasRegion,
  DockLayoutNode,
  Point,
  Size,
  PanelType,
  Rect,
} from '../../shared/types'
import {
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_DEFAULT,
  PANEL_DEFAULT_SIZES,
} from '../../shared/types'
import { autoLayout as computeAutoLayout } from '../canvas/layoutEngine'
import { viewToCanvas as viewToCanvasCoords } from '../lib/coordinates'

// -----------------------------------------------------------------------------
// Store interface
// -----------------------------------------------------------------------------

export interface CanvasStoreState {
  nodes: Record<CanvasNodeId, CanvasNodeState>
  regions: Record<string, CanvasRegion>
  annotations: Record<string, CanvasAnnotation>
  viewportOffset: Point
  zoomLevel: number
  focusedNodeId: CanvasNodeId | null
  nextZOrder: number
  nextCreationIndex: number
  containerSize: Size
  snapGuides: {
    lines: Array<{
      axis: 'x' | 'y'
      position: number
      type: 'edge' | 'center'
    }>
  }
  selectedNodeIds: Set<string>
  selectedRegionIds: Set<string>
  /** Region currently being hovered as a drop target during a node drag. */
  dropTargetRegionId: string | null
  /** Undo history — snapshots of {nodes, regions, annotations}. */
  history: CanvasHistoryEntry[]
  /** Redo stack — populated when undo() is called. */
  future: CanvasHistoryEntry[]
}

export interface CanvasHistoryEntry {
  nodes: Record<CanvasNodeId, CanvasNodeState>
  regions: Record<string, CanvasRegion>
  annotations: Record<string, CanvasAnnotation>
  focusedNodeId: CanvasNodeId | null
}

export interface CanvasStoreActions {
  // Zoom animation control
  cancelZoomAnimation: () => void

  // Mutations
  addNode: (
    panelId: string,
    panelType: PanelType,
    position?: Point,
    size?: Size,
  ) => CanvasNodeId
  removeNode: (id: CanvasNodeId) => void
  finalizeRemoveNode: (nodeId: CanvasNodeId) => void
  setNodeAnimationState: (nodeId: CanvasNodeId, state: 'entering' | 'exiting' | 'idle') => void
  moveNode: (id: CanvasNodeId, origin: Point) => void
  resizeNode: (id: CanvasNodeId, size: Size, origin?: Point) => void
  focusNode: (id: CanvasNodeId) => void
  unfocus: () => void
  toggleMaximize: (id: CanvasNodeId, viewportSize: Size) => void
  setZoom: (level: number) => void
  setViewportOffset: (offset: Point) => void
  setZoomAndOffset: (zoom: number, offset: Point) => void
  setContainerSize: (size: Size) => void
  zoomAroundCenter: (newZoom: number) => void
  animateZoomTo: (targetZoom: number) => void

  // Derived getters
  canvasToView: (point: Point) => Point
  viewToCanvas: (point: Point) => Point
  viewFrame: (nodeId: CanvasNodeId) => Rect | null
  nodeForPanel: (panelId: string) => CanvasNodeId | null
  sortedNodesByCreationOrder: () => CanvasNodeState[]
  nextNode: () => CanvasNodeId | null
  previousNode: () => CanvasNodeId | null

  // Focus and center viewport on a node
  focusAndCenter: (nodeId: CanvasNodeId) => void

  zoomToFit: () => void

  // Z-order management
  moveToFront: (nodeId: CanvasNodeId) => void
  moveToBack: (nodeId: CanvasNodeId) => void

  togglePin: (id: CanvasNodeId) => void

  setSnapGuides: (guides: {
    lines: Array<{
      axis: 'x' | 'y'
      position: number
      type: 'edge' | 'center'
    }>
  }) => void
  clearSnapGuides: () => void

  autoLayout: () => void

  // Selection
  selectNodes: (ids: string[], additive?: boolean) => void
  selectRegions: (ids: string[], additive?: boolean) => void
  clearSelection: () => void
  selectAll: () => void
  toggleNodeSelection: (id: string) => void
  toggleRegionSelection: (id: string) => void
  deleteSelection: (includeRegionContents?: boolean) => void

  // Region management
  addRegion: (label: string, origin: Point, size: Size, color?: string) => string
  removeRegion: (id: string) => void
  moveRegion: (id: string, origin: Point) => void
  resizeRegion: (id: string, size: Size, origin?: Point) => void
  renameRegion: (id: string, label: string) => void
  updateRegionColor: (id: string, color: string) => void

  // Containment
  setNodeRegion: (nodeId: string, regionId: string | undefined) => void
  getNodesInRegion: (regionId: string) => CanvasNodeState[]
  groupSelectedIntoRegion: () => string | null
  dissolveRegion: (regionId: string) => void

  // Annotation management
  addAnnotation: (type: 'stickyNote' | 'textLabel', origin: Point, content?: string) => string
  removeAnnotation: (id: string) => void
  moveAnnotation: (id: string, origin: Point) => void
  updateAnnotation: (id: string, content: string) => void
  updateAnnotationColor: (id: string, color: string) => void
  setAnnotationFontSize: (id: string, fontSize: 'sm' | 'md' | 'lg' | 'xl') => void
  setAnnotationBold: (id: string, bold: boolean) => void
  setAnnotationFontSizePx: (id: string, fontSizePx: number) => void
  resizeAnnotation: (id: string, size: { width: number; height: number }) => void

  // Per-node dock layout — replaces split/stack actions. Each canvas node owns
  // a tree (rendered via the dock primitives) that lives here as serialised
  // state. The per-node DockStore in CanvasNodeWrapper writes back via this.
  setNodeDockLayout: (nodeId: CanvasNodeId, layout: DockLayoutNode | null) => void

  // Undo/redo history
  pushHistory: () => void
  undo: () => void
  redo: () => void
  clearHistory: () => void

  // Bulk reset (used when switching workspaces)
  loadWorkspaceCanvas: (
    nodes: Record<CanvasNodeId, CanvasNodeState>,
    viewportOffset: Point,
    zoomLevel: number,
    focusedNodeId: CanvasNodeId | null,
    regions?: Record<string, CanvasRegion>,
    annotations?: Record<string, CanvasAnnotation>,
  ) => void
}

// -----------------------------------------------------------------------------
// Pending auto-edit annotations — module-level set so newly-created annotations
// enter edit mode automatically on first render (no store churn).
// -----------------------------------------------------------------------------

const pendingEditAnnotations = new Set<string>()
export function consumePendingAnnotationEdit(id: string): boolean {
  if (pendingEditAnnotations.has(id)) {
    pendingEditAnnotations.delete(id)
    return true
  }
  return false
}

export type CanvasStore = CanvasStoreState & CanvasStoreActions

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function generateId(): string {
  return crypto.randomUUID()
}

/**
 * Find a free position for a new node that does not overlap any existing node.
 * Starts from a preferred anchor (explicit position, focused node, or last
 * node) and searches outward in a spiral until a non-overlapping slot is
 * found. Guarantees the returned rect does not overlap any existing node.
 */
function findFreePosition(
  nodes: Record<CanvasNodeId, CanvasNodeState>,
  focusedNodeId: CanvasNodeId | null,
  defaultSize: Size,
  preferred?: Point,
): Point {
  const nodeList = Object.values(nodes)
  if (nodeList.length === 0) {
    return preferred ?? { x: 100, y: 100 }
  }

  const gap = 40

  // Determine the anchor point we'd ideally place the new node at.
  let anchor: Point
  if (preferred) {
    anchor = preferred
  } else {
    const reference =
      (focusedNodeId && nodes[focusedNodeId]) ||
      nodeList[nodeList.length - 1]
    anchor = {
      x: reference.origin.x + reference.size.width + gap,
      y: reference.origin.y,
    }
  }

  const fits = (p: Point): boolean => {
    const rect = { origin: p, size: defaultSize }
    return !nodeList.some((n) =>
      rectsOverlap({ origin: n.origin, size: n.size }, rect),
    )
  }

  if (fits(anchor)) return anchor

  // Spiral search outward from the anchor on a coarse grid until we find a
  // slot. Step is sized so we explore quickly but never miss small gaps.
  const stepX = Math.max(40, Math.floor(defaultSize.width / 2))
  const stepY = Math.max(40, Math.floor(defaultSize.height / 2))
  // Directions: right, down, left, up
  const dirs: Array<[number, number]> = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ]
  let x = anchor.x
  let y = anchor.y
  let legLen = 1
  const maxRings = 80
  for (let ring = 0; ring < maxRings; ring++) {
    for (let d = 0; d < 4; d++) {
      const [dx, dy] = dirs[d]
      for (let s = 0; s < legLen; s++) {
        x += dx * stepX
        y += dy * stepY
        const candidate = { x, y }
        if (fits(candidate)) return candidate
      }
      if (d === 1 || d === 3) legLen++
    }
  }

  // Last-resort fallback: stack far to the right of the rightmost node.
  const rightmost = nodeList.reduce((acc, n) => {
    const right = n.origin.x + n.size.width
    return right > acc ? right : acc
  }, -Infinity)
  return { x: rightmost + gap, y: anchor.y }
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return !(
    a.origin.x + a.size.width <= b.origin.x ||
    b.origin.x + b.size.width <= a.origin.x ||
    a.origin.y + a.size.height <= b.origin.y ||
    b.origin.y + b.size.height <= a.origin.y
  )
}

// -----------------------------------------------------------------------------
// Store factory — creates independent canvas store instances
// -----------------------------------------------------------------------------

export function createCanvasStore(): UseBoundStore<StoreApi<CanvasStore>> {
  // Each store instance gets its own zoom animation RAF tracking
  let activeZoomAnimationRafId = 0

  function cancelZoomAnim() {
    if (activeZoomAnimationRafId) {
      cancelAnimationFrame(activeZoomAnimationRafId)
      activeZoomAnimationRafId = 0
    }
  }

  return create<CanvasStore>((set, get) => ({
  // --- State ---
  nodes: {},
  regions: {},
  annotations: {},
  viewportOffset: { x: 0, y: 0 },
  zoomLevel: ZOOM_DEFAULT,
  focusedNodeId: null,
  nextZOrder: 0,
  nextCreationIndex: 0,
  containerSize: { width: 0, height: 0 },
  snapGuides: { lines: [] },
  selectedNodeIds: new Set<string>(),
  selectedRegionIds: new Set<string>(),
  dropTargetRegionId: null,
  history: [],
  future: [],

  // --- Actions ---

  cancelZoomAnimation: cancelZoomAnim,

  pushHistory() {
    const state = get()
    const entry: CanvasHistoryEntry = {
      nodes: state.nodes,
      regions: state.regions,
      annotations: state.annotations,
      focusedNodeId: state.focusedNodeId,
    }
    const MAX = 100
    const history = state.history.length >= MAX
      ? [...state.history.slice(1), entry]
      : [...state.history, entry]
    set({ history, future: [] })
  },

  undo() {
    const state = get()
    if (state.history.length === 0) return
    const prev = state.history[state.history.length - 1]
    const current: CanvasHistoryEntry = {
      nodes: state.nodes,
      regions: state.regions,
      annotations: state.annotations,
      focusedNodeId: state.focusedNodeId,
    }
    set({
      nodes: prev.nodes,
      regions: prev.regions,
      annotations: prev.annotations,
      focusedNodeId: prev.focusedNodeId,
      history: state.history.slice(0, -1),
      future: [...state.future, current],
    })
  },

  redo() {
    const state = get()
    if (state.future.length === 0) return
    const next = state.future[state.future.length - 1]
    const current: CanvasHistoryEntry = {
      nodes: state.nodes,
      regions: state.regions,
      annotations: state.annotations,
      focusedNodeId: state.focusedNodeId,
    }
    set({
      nodes: next.nodes,
      regions: next.regions,
      annotations: next.annotations,
      focusedNodeId: next.focusedNodeId,
      history: [...state.history, current],
      future: state.future.slice(0, -1),
    })
  },

  clearHistory() {
    set({ history: [], future: [] })
  },

  addNode(panelId, panelType, position?, size?) {
    get().pushHistory()
    const state = get()
    const nodeId = generateId()
    const defaultSize = size ?? PANEL_DEFAULT_SIZES[panelType]
    // If the caller provided an explicit position (e.g. a drop at the cursor),
    // respect it exactly — overlapping is fine, the user picked the spot.
    // Otherwise run smart placement so auto-created nodes don't overlap.
    const origin = position
      ? position
      : findFreePosition(state.nodes, state.focusedNodeId, defaultSize, undefined)

    const node: CanvasNodeState = {
      id: nodeId,
      panelId,
      origin,
      size: defaultSize,
      zOrder: state.nextZOrder,
      creationIndex: state.nextCreationIndex,
      animationState: 'entering',
      // Seed the per-node dock layout with a single tab stack containing the
      // initial panel. The CanvasNodeWrapper hydrates this into a per-node
      // DockStore on mount.
      dockLayout: {
        type: 'tabs',
        id: generateId(),
        panelIds: [panelId],
        activeIndex: 0,
      },
    }

    set({
      nodes: { ...state.nodes, [nodeId]: node },
      nextZOrder: state.nextZOrder + 1,
      nextCreationIndex: state.nextCreationIndex + 1,
    })

    return nodeId
  },

  removeNode(id) {
    if (get().nodes[id]) get().pushHistory()
    set((state) => {
      const node = state.nodes[id]
      if (!node) return state
      return {
        nodes: {
          ...state.nodes,
          [id]: { ...node, animationState: 'exiting' as const },
        },
        focusedNodeId: state.focusedNodeId === id ? null : state.focusedNodeId,
      }
    })
  },

  finalizeRemoveNode(nodeId) {
    const { [nodeId]: _, ...rest } = get().nodes
    set({ nodes: rest })
  },

  setNodeAnimationState(nodeId, state) {
    const node = get().nodes[nodeId]
    if (node) {
      set({ nodes: { ...get().nodes, [nodeId]: { ...node, animationState: state } } })
    }
  },

  moveNode(id, origin) {
    set((state) => {
      const node = state.nodes[id]
      if (!node) return state
      return {
        nodes: {
          ...state.nodes,
          [id]: { ...node, origin },
        },
      }
    })
  },

  resizeNode(id, size, origin?) {
    set((state) => {
      const node = state.nodes[id]
      if (!node) return state
      return {
        nodes: {
          ...state.nodes,
          [id]: {
            ...node,
            size,
            ...(origin != null ? { origin } : {}),
          },
        },
      }
    })
  },

  focusNode(id) {
    set((state) => {
      const node = state.nodes[id]
      if (!node) return state
      return {
        nodes: {
          ...state.nodes,
          [id]: { ...node, zOrder: state.nextZOrder },
        },
        nextZOrder: state.nextZOrder + 1,
        focusedNodeId: id,
      }
    })
  },

  unfocus() {
    set({ focusedNodeId: null })
  },

  toggleMaximize(id, viewportSize) {
    const state = get()
    const node = state.nodes[id]
    if (!node) return

    const isMaximized = node.preMaximizeOrigin != null

    let updated: CanvasNodeState
    if (isMaximized) {
      // Restore pre-maximize geometry
      updated = {
        ...node,
        origin: node.preMaximizeOrigin!,
        size: node.preMaximizeSize!,
        preMaximizeOrigin: undefined,
        preMaximizeSize: undefined,
      }
    } else {
      // Save current geometry and maximize to fill visible canvas area
      const cs = state.containerSize
      const topLeft = get().viewToCanvas({ x: 0, y: 0 })
      const bottomRight = get().viewToCanvas({
        x: cs.width || viewportSize.width,
        y: cs.height || viewportSize.height,
      })
      const padding = 20 / state.zoomLevel

      updated = {
        ...node,
        preMaximizeOrigin: { ...node.origin },
        preMaximizeSize: { ...node.size },
        origin: {
          x: topLeft.x + padding,
          y: topLeft.y + padding,
        },
        size: {
          width: (bottomRight.x - topLeft.x) - padding * 2,
          height: (bottomRight.y - topLeft.y) - padding * 2,
        },
      }
    }

    // Focus the node as well (bump zOrder)
    updated = { ...updated, zOrder: state.nextZOrder }

    set({
      nodes: { ...state.nodes, [id]: updated },
      nextZOrder: state.nextZOrder + 1,
      focusedNodeId: id,
    })
  },

  setZoom(level) {
    const clamped = Math.min(Math.max(level, ZOOM_MIN), ZOOM_MAX)
    set({ zoomLevel: clamped })
  },

  setViewportOffset(offset) {
    set({ viewportOffset: offset })
  },

  setZoomAndOffset(zoom, offset) {
    const clamped = Math.min(Math.max(zoom, ZOOM_MIN), ZOOM_MAX)
    set({ zoomLevel: clamped, viewportOffset: offset })
  },

  setContainerSize(size) {
    set({ containerSize: size })
  },

  zoomAroundCenter(newZoom) {
    const state = get()
    const clamped = Math.min(Math.max(newZoom, ZOOM_MIN), ZOOM_MAX)
    if (clamped === state.zoomLevel) return
    const cs = state.containerSize
    if (cs.width === 0 || cs.height === 0) {
      // Fallback if container size not yet measured
      set({ zoomLevel: clamped })
      return
    }
    const centerView = { x: cs.width / 2, y: cs.height / 2 }
    const centerCanvas = {
      x: (centerView.x - state.viewportOffset.x) / state.zoomLevel,
      y: (centerView.y - state.viewportOffset.y) / state.zoomLevel,
    }
    set({
      zoomLevel: clamped,
      viewportOffset: {
        x: centerView.x - centerCanvas.x * clamped,
        y: centerView.y - centerCanvas.y * clamped,
      },
    })
  },

  animateZoomTo(targetZoom) {
    cancelZoomAnim()

    const clampedTarget = Math.min(Math.max(targetZoom, ZOOM_MIN), ZOOM_MAX)

    const tick = () => {
      const state = get()
      const diff = clampedTarget - state.zoomLevel

      if (Math.abs(diff) < 0.001) {
        // Snap to exact target
        const centerX = (state.containerSize?.width || window.innerWidth) / 2
        const centerY = (state.containerSize?.height || window.innerHeight) / 2
        const canvasPoint = viewToCanvasCoords({ x: centerX, y: centerY }, state.zoomLevel, state.viewportOffset)
        set({
          zoomLevel: clampedTarget,
          viewportOffset: {
            x: centerX - canvasPoint.x * clampedTarget,
            y: centerY - canvasPoint.y * clampedTarget,
          },
        })
        activeZoomAnimationRafId = 0
        return
      }

      const newZoom = state.zoomLevel + diff * 0.15
      const centerX = (state.containerSize?.width || window.innerWidth) / 2
      const centerY = (state.containerSize?.height || window.innerHeight) / 2
      const canvasPoint = viewToCanvasCoords({ x: centerX, y: centerY }, state.zoomLevel, state.viewportOffset)
      set({
        zoomLevel: newZoom,
        viewportOffset: {
          x: centerX - canvasPoint.x * newZoom,
          y: centerY - canvasPoint.y * newZoom,
        },
      })

      activeZoomAnimationRafId = requestAnimationFrame(tick)
    }

    activeZoomAnimationRafId = requestAnimationFrame(tick)
  },

  // --- Derived getters ---

  canvasToView(point) {
    const { zoomLevel, viewportOffset } = get()
    return {
      x: point.x * zoomLevel + viewportOffset.x,
      y: point.y * zoomLevel + viewportOffset.y,
    }
  },

  viewToCanvas(point) {
    const { zoomLevel, viewportOffset } = get()
    return {
      x: (point.x - viewportOffset.x) / zoomLevel,
      y: (point.y - viewportOffset.y) / zoomLevel,
    }
  },

  viewFrame(nodeId) {
    const { nodes, zoomLevel } = get()
    const node = nodes[nodeId]
    if (!node) return null
    const viewOrigin = get().canvasToView(node.origin)
    return {
      origin: viewOrigin,
      size: {
        width: node.size.width * zoomLevel,
        height: node.size.height * zoomLevel,
      },
    }
  },

  nodeForPanel(panelId) {
    const { nodes } = get()
    const found = Object.values(nodes).find((n) => n.panelId === panelId)
    return found?.id ?? null
  },

  sortedNodesByCreationOrder() {
    const { nodes } = get()
    return Object.values(nodes).sort((a, b) => a.creationIndex - b.creationIndex)
  },

  nextNode() {
    const { focusedNodeId } = get()
    const sorted = get().sortedNodesByCreationOrder()
    if (sorted.length === 0) return null
    if (!focusedNodeId) return sorted[0].id
    const index = sorted.findIndex((n) => n.id === focusedNodeId)
    if (index === -1) return sorted[0].id
    return sorted[(index + 1) % sorted.length].id
  },

  previousNode() {
    const { focusedNodeId } = get()
    const sorted = get().sortedNodesByCreationOrder()
    if (sorted.length === 0) return null
    if (!focusedNodeId) return sorted[sorted.length - 1].id
    const index = sorted.findIndex((n) => n.id === focusedNodeId)
    if (index === -1) return sorted[sorted.length - 1].id
    return sorted[(index - 1 + sorted.length) % sorted.length].id
  },

  moveToFront(nodeId) {
    set((state) => {
      const node = state.nodes[nodeId]
      if (!node) return state
      return {
        nodes: { ...state.nodes, [nodeId]: { ...node, zOrder: state.nextZOrder } },
        nextZOrder: state.nextZOrder + 1,
      }
    })
  },

  moveToBack(nodeId) {
    set((state) => {
      const node = state.nodes[nodeId]
      if (!node) return state
      const nodeList = Object.values(state.nodes)
      const minZOrder = nodeList.reduce((min, n) => Math.min(min, n.zOrder), Infinity)
      return {
        nodes: { ...state.nodes, [nodeId]: { ...node, zOrder: minZOrder - 1 } },
      }
    })
  },

  focusAndCenter(nodeId) {
    const state = get()
    const node = state.nodes[nodeId]
    if (!node) return
    const updated = { ...node, zOrder: state.nextZOrder }
    const cs = state.containerSize
    const zoom = state.zoomLevel
    const newState: Partial<CanvasStoreState> = {
      nodes: { ...state.nodes, [nodeId]: updated },
      nextZOrder: state.nextZOrder + 1,
      focusedNodeId: nodeId,
    }
    if (cs.width > 0 && cs.height > 0) {
      newState.viewportOffset = {
        x: cs.width / 2 - (node.origin.x + node.size.width / 2) * zoom,
        y: cs.height / 2 - (node.origin.y + node.size.height / 2) * zoom,
      }
    }
    set(newState)
  },

  zoomToFit() {
    const state = get()
    const nodeList = Object.values(state.nodes)
    if (nodeList.length === 0) return
    const cs = state.containerSize
    if (cs.width === 0 || cs.height === 0) return

    const minX = Math.min(...nodeList.map(n => n.origin.x))
    const minY = Math.min(...nodeList.map(n => n.origin.y))
    const maxX = Math.max(...nodeList.map(n => n.origin.x + n.size.width))
    const maxY = Math.max(...nodeList.map(n => n.origin.y + n.size.height))

    const padding = 60
    const contentW = maxX - minX + padding * 2
    const contentH = maxY - minY + padding * 2
    const zoom = Math.min(Math.max(Math.min(cs.width / contentW, cs.height / contentH), ZOOM_MIN), ZOOM_MAX)

    set({
      zoomLevel: zoom,
      viewportOffset: {
        x: (cs.width - contentW * zoom) / 2 - (minX - padding) * zoom,
        y: (cs.height - contentH * zoom) / 2 - (minY - padding) * zoom,
      },
    })
  },

  togglePin(id) {
    set((state) => {
      const node = state.nodes[id]
      if (!node) return state
      return {
        nodes: { ...state.nodes, [id]: { ...node, isPinned: !node.isPinned } },
      }
    })
  },

  setSnapGuides(guides) {
    set({ snapGuides: guides })
  },

  clearSnapGuides() {
    set({ snapGuides: { lines: [] } })
  },

  // --- Selection ---

  selectNodes(ids, additive) {
    set((state) => {
      const next = additive ? new Set(state.selectedNodeIds) : new Set<string>()
      for (const id of ids) next.add(id)
      return { selectedNodeIds: next }
    })
  },

  selectRegions(ids, additive) {
    set((state) => {
      const nextRegions = additive ? new Set(state.selectedRegionIds) : new Set<string>()
      let nextNodes = additive ? new Set(state.selectedNodeIds) : new Set<string>()
      for (const id of ids) {
        nextRegions.add(id)
        // Cascade: select all contained nodes
        for (const node of Object.values(state.nodes)) {
          if (node.regionId === id) nextNodes.add(node.id)
        }
      }
      return { selectedRegionIds: nextRegions, selectedNodeIds: nextNodes }
    })
  },

  clearSelection() {
    set({ selectedNodeIds: new Set<string>(), selectedRegionIds: new Set<string>() })
  },

  selectAll() {
    set((state) => ({
      selectedNodeIds: new Set(Object.keys(state.nodes)),
      selectedRegionIds: new Set(Object.keys(state.regions)),
    }))
  },

  toggleNodeSelection(id) {
    set((state) => {
      const next = new Set(state.selectedNodeIds)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { selectedNodeIds: next }
    })
  },

  toggleRegionSelection(id) {
    set((state) => {
      const nextRegions = new Set(state.selectedRegionIds)
      const nextNodes = new Set(state.selectedNodeIds)
      if (nextRegions.has(id)) {
        nextRegions.delete(id)
        // Also deselect contained nodes
        for (const node of Object.values(state.nodes)) {
          if (node.regionId === id) nextNodes.delete(node.id)
        }
      } else {
        nextRegions.add(id)
        // Also select contained nodes
        for (const node of Object.values(state.nodes)) {
          if (node.regionId === id) nextNodes.add(node.id)
        }
      }
      return { selectedRegionIds: nextRegions, selectedNodeIds: nextNodes }
    })
  },

  deleteSelection(includeRegionContents) {
    const state = get()
    if (state.selectedNodeIds.size > 0 || state.selectedRegionIds.size > 0) {
      state.pushHistory()
    }

    // Collect node IDs to remove (selected nodes + region contents if requested)
    const nodeIdsToRemove = new Set(state.selectedNodeIds)
    for (const regionId of state.selectedRegionIds) {
      if (includeRegionContents) {
        for (const node of Object.values(state.nodes)) {
          if (node.regionId === regionId) nodeIdsToRemove.add(node.id)
        }
      }
    }

    // Trigger exit animation for each node (cleanup happens in component lifecycle)
    for (const nodeId of nodeIdsToRemove) {
      get().removeNode(nodeId)
    }

    // Handle regions: detach children of non-content-deleted regions, then remove
    set((s) => {
      const updatedNodes = { ...s.nodes }
      const updatedRegions = { ...s.regions }

      for (const regionId of state.selectedRegionIds) {
        if (!includeRegionContents) {
          // Detach children that weren't deleted
          for (const nodeId of Object.keys(updatedNodes)) {
            if (updatedNodes[nodeId].regionId === regionId) {
              updatedNodes[nodeId] = { ...updatedNodes[nodeId], regionId: undefined }
            }
          }
        }
        delete updatedRegions[regionId]
      }

      return {
        nodes: updatedNodes,
        regions: updatedRegions,
        selectedNodeIds: new Set<string>(),
        selectedRegionIds: new Set<string>(),
      }
    })
  },

  autoLayout() {
    const state = get()
    const nodeList = Object.values(state.nodes).sort((a, b) => a.creationIndex - b.creationIndex)
    if (nodeList.length === 0) return

    const containerWidth = state.containerSize.width > 0
      ? state.containerSize.width / state.zoomLevel
      : 1200

    const positions = computeAutoLayout(
      nodeList.map(n => ({ id: n.id, size: n.size })),
      containerWidth,
      40,
    )

    const updatedNodes = { ...state.nodes }
    for (const [id, origin] of Object.entries(positions)) {
      updatedNodes[id] = { ...updatedNodes[id], origin }
    }

    set({ nodes: updatedNodes })

    // Zoom to fit after layout
    get().zoomToFit()
  },

  addRegion(label, origin, size, color) {
    const id = generateId()
    const region: CanvasRegion = {
      id,
      origin,
      size,
      label,
      color: color || 'rgba(74, 158, 255, 0.08)',
      zOrder: -1000,
    }
    set((state) => ({
      regions: { ...state.regions, [id]: region },
    }))
    return id
  },

  removeRegion(id) {
    set((state) => {
      const { [id]: _, ...rest } = state.regions
      return { regions: rest }
    })
  },

  moveRegion(id, origin) {
    set((state) => {
      const region = state.regions[id]
      if (!region) return state
      const dx = origin.x - region.origin.x
      const dy = origin.y - region.origin.y
      const updatedNodes = { ...state.nodes }
      for (const node of Object.values(state.nodes)) {
        if (node.regionId === id) {
          updatedNodes[node.id] = {
            ...node,
            origin: { x: node.origin.x + dx, y: node.origin.y + dy },
          }
        }
      }
      return {
        regions: { ...state.regions, [id]: { ...region, origin } },
        nodes: updatedNodes,
      }
    })
  },

  resizeRegion(id, size, origin) {
    set((state) => {
      const region = state.regions[id]
      if (!region) return state
      return {
        regions: {
          ...state.regions,
          [id]: { ...region, size, ...(origin ? { origin } : {}) },
        },
      }
    })
  },

  renameRegion(id, label) {
    set((state) => {
      const region = state.regions[id]
      if (!region) return state
      return {
        regions: { ...state.regions, [id]: { ...region, label } },
      }
    })
  },

  updateRegionColor(id, color) {
    set((state) => {
      const region = state.regions[id]
      if (!region) return state
      return {
        regions: { ...state.regions, [id]: { ...region, color } },
      }
    })
  },

  // --- Containment ---

  setNodeRegion(nodeId, regionId) {
    set((state) => {
      const node = state.nodes[nodeId]
      if (!node) return state
      return {
        nodes: { ...state.nodes, [nodeId]: { ...node, regionId } },
      }
    })
  },

  getNodesInRegion(regionId) {
    return Object.values(get().nodes).filter((n) => n.regionId === regionId)
  },

  groupSelectedIntoRegion() {
    const state = get()
    const selectedNodes = Object.values(state.nodes).filter((n) => state.selectedNodeIds.has(n.id))
    if (selectedNodes.length === 0) return null

    // Compute bounding box with padding
    const padding = 30
    const minX = Math.min(...selectedNodes.map((n) => n.origin.x)) - padding
    const minY = Math.min(...selectedNodes.map((n) => n.origin.y)) - padding
    const maxX = Math.max(...selectedNodes.map((n) => n.origin.x + n.size.width)) + padding
    const maxY = Math.max(...selectedNodes.map((n) => n.origin.y + n.size.height)) + padding

    const regionId = get().addRegion(
      'Region',
      { x: minX, y: minY },
      { width: maxX - minX, height: maxY - minY },
    )

    // Assign regionId to all selected nodes
    set((s) => {
      const updatedNodes = { ...s.nodes }
      for (const node of selectedNodes) {
        updatedNodes[node.id] = { ...updatedNodes[node.id], regionId }
      }
      return { nodes: updatedNodes }
    })

    return regionId
  },

  dissolveRegion(regionId) {
    set((state) => {
      // Detach all children
      const updatedNodes = { ...state.nodes }
      for (const nodeId of Object.keys(updatedNodes)) {
        if (updatedNodes[nodeId].regionId === regionId) {
          updatedNodes[nodeId] = { ...updatedNodes[nodeId], regionId: undefined }
        }
      }
      // Remove the region
      const { [regionId]: _, ...restRegions } = state.regions
      // Remove from selection
      const nextRegionIds = new Set(state.selectedRegionIds)
      nextRegionIds.delete(regionId)
      return { nodes: updatedNodes, regions: restRegions, selectedRegionIds: nextRegionIds }
    })
  },

  addAnnotation(type, origin, content) {
    const id = generateId()
    const annotation: CanvasAnnotation = {
      id,
      type,
      origin,
      size: type === 'stickyNote' ? { width: 180, height: 140 } : { width: 120, height: 28 },
      content: content || '',
      color: type === 'stickyNote' ? 'rgba(255, 221, 87, 0.92)' : 'transparent',
    }
    // Mark the new annotation to enter edit mode on first render — unless the
    // caller provided initial content (e.g. session restore).
    if (!content) pendingEditAnnotations.add(id)
    set((state) => ({
      annotations: { ...state.annotations, [id]: annotation },
    }))
    return id
  },

  removeAnnotation(id) {
    set((state) => {
      const { [id]: _, ...rest } = state.annotations
      return { annotations: rest }
    })
  },

  moveAnnotation(id, origin) {
    set((state) => {
      const ann = state.annotations[id]
      if (!ann) return state
      return { annotations: { ...state.annotations, [id]: { ...ann, origin } } }
    })
  },

  updateAnnotation(id, content) {
    set((state) => {
      const ann = state.annotations[id]
      if (!ann) return state
      return { annotations: { ...state.annotations, [id]: { ...ann, content } } }
    })
  },

  updateAnnotationColor(id, color) {
    set((state) => {
      const ann = state.annotations[id]
      if (!ann) return state
      return { annotations: { ...state.annotations, [id]: { ...ann, color } } }
    })
  },

  setAnnotationFontSize(id, fontSize) {
    set((state) => {
      const ann = state.annotations[id]
      if (!ann) return state
      return { annotations: { ...state.annotations, [id]: { ...ann, fontSize } } }
    })
  },

  setAnnotationFontSizePx(id, fontSizePx) {
    set((state) => {
      const ann = state.annotations[id]
      if (!ann) return state
      const clamped = Math.max(6, Math.min(400, fontSizePx))
      return { annotations: { ...state.annotations, [id]: { ...ann, fontSizePx: clamped } } }
    })
  },

  setAnnotationBold(id, bold) {
    set((state) => {
      const ann = state.annotations[id]
      if (!ann) return state
      return { annotations: { ...state.annotations, [id]: { ...ann, bold } } }
    })
  },

  resizeAnnotation(id, size) {
    set((state) => {
      const ann = state.annotations[id]
      if (!ann) return state
      const w = Math.max(60, size.width)
      const h = Math.max(40, size.height)
      return {
        annotations: {
          ...state.annotations,
          [id]: { ...ann, size: { width: w, height: h } },
        },
      }
    })
  },

  setNodeDockLayout(nodeId, layout) {
    set((state) => {
      const node = state.nodes[nodeId]
      if (!node) return state
      return {
        nodes: {
          ...state.nodes,
          [nodeId]: { ...node, dockLayout: layout },
        },
      }
    })
  },

  loadWorkspaceCanvas(nodes, viewportOffset, zoomLevel, focusedNodeId, regions, annotations) {
    // Compute next counters from loaded data
    const nodeList = Object.values(nodes)
    const maxZOrder = nodeList.reduce((max, n) => Math.max(max, n.zOrder), -1)
    const maxCreationIndex = nodeList.reduce((max, n) => Math.max(max, n.creationIndex), -1)

    // Ensure all loaded nodes have animationState: 'idle' so they don't animate on restore
    const idleNodes: Record<string, CanvasNodeState> = {}
    for (const [id, node] of Object.entries(nodes)) {
      idleNodes[id] = { ...node, animationState: 'idle' }
    }

    set({
      nodes: idleNodes,
      regions: regions ?? {},
      annotations: annotations ?? {},
      viewportOffset,
      zoomLevel: Math.min(Math.max(zoomLevel, ZOOM_MIN), ZOOM_MAX),
      focusedNodeId,
      nextZOrder: maxZOrder + 1,
      nextCreationIndex: maxCreationIndex + 1,
      selectedNodeIds: new Set<string>(),
      selectedRegionIds: new Set<string>(),
      history: [],
      future: [],
    })
  },
}))
}

// -----------------------------------------------------------------------------
// Default singleton — backward-compatible during migration
// -----------------------------------------------------------------------------

export const useCanvasStore = createCanvasStore()

// -----------------------------------------------------------------------------
// Per-panel store registry — gives each CanvasPanel a stable, unique store
// keyed by panelId. Persists across remounts so dock layout reshuffles don't
// destroy a canvas's state. The first canvas to register aliases the legacy
// singleton store so existing canvasOps/session restore code keeps working.
// -----------------------------------------------------------------------------

const canvasStoresByPanelId = new Map<string, UseBoundStore<StoreApi<CanvasStore>>>()
let defaultStoreOwnerPanelId: string | null = null

export function getOrCreateCanvasStoreForPanel(
  panelId: string,
): UseBoundStore<StoreApi<CanvasStore>> {
  const existing = canvasStoresByPanelId.get(panelId)
  if (existing) return existing
  if (defaultStoreOwnerPanelId === null) {
    defaultStoreOwnerPanelId = panelId
    canvasStoresByPanelId.set(panelId, useCanvasStore)
    return useCanvasStore
  }
  const store = createCanvasStore()
  canvasStoresByPanelId.set(panelId, store)
  return store
}

export function releaseCanvasStoreForPanel(panelId: string): void {
  canvasStoresByPanelId.delete(panelId)
  if (defaultStoreOwnerPanelId === panelId) defaultStoreOwnerPanelId = null
}

/** Iterate every live CanvasStore (one per canvas panel currently mounted).
 *  Used by drag handlers to find the source canvas of a given node id. */
export function getAllCanvasStores(): UseBoundStore<StoreApi<CanvasStore>>[] {
  return Array.from(canvasStoresByPanelId.values())
}

/** Find the canvas store that currently owns the given node id, if any. */
export function findCanvasStoreForNode(nodeId: string): UseBoundStore<StoreApi<CanvasStore>> | null {
  for (const store of canvasStoresByPanelId.values()) {
    if (store.getState().nodes[nodeId]) return store
  }
  return null
}

/** @deprecated Use store.getState().cancelZoomAnimation() instead */
export function cancelZoomAnimation() {
  useCanvasStore.getState().cancelZoomAnimation()
}

// -----------------------------------------------------------------------------
// Granular selectors
// -----------------------------------------------------------------------------

/**
 * Returns a stable sorted array of node IDs ordered by zOrder.
 * Only triggers a re-render when nodes are added, removed, or z-order changes.
 */
export function useNodeIds(store?: UseBoundStore<StoreApi<CanvasStore>>): string[] {
  return useStoreWithEqualityFn(
    store ?? useCanvasStore,
    (s) => Object.values(s.nodes)
      .sort((a, b) => a.zOrder - b.zOrder)
      .map(n => n.id),
    (a, b) => {
      if (a.length !== b.length) return false
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false
      }
      return true
    },
  )
}
