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
import { autoLayoutAll as computeAutoLayoutAll } from '../canvas/layoutEngine'
import { viewToCanvas as viewToCanvasCoords } from '../lib/coordinates'
import { REGION_FILL_COLORS } from '../../shared/colors'
import { perfCount } from '../lib/perf/perfClient'
import {
  recommendPlacements,
  findFreePosition,
  nudgeToFree,
  type PlacementCandidate,
} from '../canvas/placement'

// Under e2e the windows are hidden, which throttles rAF — the rAF-driven
// entering->idle node transition can stall, leaving nodes at scale(0.85) so
// boundingBox-based drag specs grab the wrong point. Create nodes already idle
// in e2e so their geometry is final immediately (no enter animation).
const IS_E2E = typeof window !== 'undefined' && window.electronAPI?.isE2E === true

// -----------------------------------------------------------------------------
// Store interface
// -----------------------------------------------------------------------------

/** Interactive ghost placement awaiting a user-chosen spot. */
export interface PendingPlacement {
  panelId: string
  panelType: PanelType
  /** 3–5 recommended spots; candidates[0] is the best. User picks by click or number. */
  candidates: PlacementCandidate[]
  hoveredIndex: number | null
  /** Free "place anywhere" mode — armed by pressing F. While armed, the cursor
   *  shows a "Place here" ghost and a click drops there; otherwise the ghost is
   *  hidden and clicking empty canvas cancels. */
  freeArmed: boolean
  /** Escape hatch preview: where a free "click-anywhere" placement would land
   *  (only while `freeArmed`). */
  freeGhost: { point: Point; size: Size } | null
  /** Viewport before we zoomed out to show recommendations — restored on cancel/commit. */
  prevZoom: number
  prevOffset: Point
  /** Invoked if the placement is cancelled — rolls the orphan panel record back. */
  onCancelled?: (panelId: string) => void
}

export interface CanvasStoreState {
  nodes: Record<CanvasNodeId, CanvasNodeState>
  regions: Record<string, CanvasRegion>
  viewportOffset: Point
  zoomLevel: number
  focusedNodeId: CanvasNodeId | null
  /** Increments on every focus action — lets panels re-run focus side effects even when focusedNodeId doesn't change. */
  focusEpoch: number
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
  /** When true, the auto-focus-largest-visible hook stands down. Set while the
   *  user is moving the canvas by keyboard (Cmd+Arrow jump / Shift+Arrow pan)
   *  so those movements don't auto-activate whatever scrolls into view; cleared
   *  by any explicit focus, manual pan, or zoom. */
  suppressAutoFocus: boolean
  /** Region currently being hovered as a drop target during a node drag. */
  dropTargetRegionId: string | null
  /** Undo history — snapshots of {nodes, regions}. */
  history: CanvasHistoryEntry[]
  /** Redo stack — populated when undo() is called. */
  future: CanvasHistoryEntry[]
  /** Interactive ghost placement in progress (null when idle). */
  pendingPlacement: PendingPlacement | null
}

export interface CanvasHistoryEntry {
  nodes: Record<CanvasNodeId, CanvasNodeState>
  regions: Record<string, CanvasRegion>
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
  // Smoothly ease the viewport offset toward a target (Shift/Cmd+Arrow movement)
  animateViewportTo: (target: Point) => void

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

  // Interactive ghost placement
  /** Record the latest canvas-space pointer position so recommendations can be
   *  anchored to where the mouse is hovering. Non-reactive (no re-render). */
  setPlacementPointer: (point: Point | null) => void
  /** Begin interactive ghost placement: compute 3–5 recommended spots, zoom out
   *  to reveal them, and render numbered ghosts. Returns true if ghosts are shown
   *  (caller must NOT also place the node). `onCancelled` rolls the panel back. */
  beginPlacement: (
    panelId: string,
    panelType: PanelType,
    onCancelled?: (panelId: string) => void,
  ) => boolean
  /** Commit the pending placement at the given candidate index; returns the new node id. */
  commitPlacement: (index: number) => CanvasNodeId | null
  /** Arm/disarm free "place anywhere" mode (press F). Disarming clears the ghost. */
  setFreeArmed: (armed: boolean) => void
  /** Escape hatch: preview a free placement centred on `point` (canvas-space),
   *  nudged to the nearest non-overlapping spot. No-op when idle. */
  updatePlacementCursor: (point: Point) => void
  /** Escape hatch: commit a free placement centred on `point` (click-anywhere). */
  commitFreePlacement: (point: Point) => CanvasNodeId | null
  /** Cancel the pending placement and roll back the orphan panel record. */
  cancelPlacement: () => void
  /** Highlight a candidate ghost (null clears the hover). */
  setPlacementHover: (index: number | null) => void

  // Move focus to the spatially-nearest node in a direction, centering it
  navigateDirection: (dir: 'up' | 'down' | 'left' | 'right') => void

  // Move the selection cursor to the spatially-nearest node in a direction and
  // centre it — without focusing it, so panel content never grabs the keyboard
  // and the user can keep jumping (Cmd+Arrow).
  navigateSelect: (dir: 'up' | 'down' | 'left' | 'right') => void

  // Pan the canvas viewport one step in a direction (Shift+Arrow).
  panViewport: (dir: 'up' | 'down' | 'left' | 'right') => void

  zoomToFit: () => void
  zoomToSelection: () => void

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
  setRegionDefaultCwd: (id: string, defaultCwd: string | undefined) => void

  // Containment
  setNodeRegion: (nodeId: string, regionId: string | undefined) => void
  getNodesInRegion: (regionId: string) => CanvasNodeState[]
  groupSelectedIntoRegion: () => string | null
  groupSelectedHorizontal: () => string | null
  stackSelected: (axis: 'row' | 'column', gap?: number) => void
  tidyGridSelected: (gap?: number) => void
  dissolveRegion: (regionId: string) => void

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
  ) => void
}

export type CanvasStore = CanvasStoreState & CanvasStoreActions

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function generateId(): string {
  return crypto.randomUUID()
}


/** View-space pixels the canvas pans per Shift+Arrow keystroke. */
const PAN_STEP = 120

/**
 * Find the spatially-nearest node in a direction from a reference centre.
 * Uses a directional cone: the candidate must lie in the half-plane AND the
 * move axis must dominate, so we don't jump to a node that's mostly sideways.
 * Shared by navigateDirection (focus + activate) and navigateSelect (select
 * without activating).
 */
function findNodeInDirection(
  nodeList: CanvasNodeState[],
  refX: number,
  refY: number,
  dir: 'up' | 'down' | 'left' | 'right',
  excludeId?: CanvasNodeId,
): CanvasNodeState | null {
  let best: CanvasNodeState | null = null
  let bestScore = Infinity
  for (const n of nodeList) {
    if (excludeId && n.id === excludeId) continue
    const dx = n.origin.x + n.size.width / 2 - refX
    const dy = n.origin.y + n.size.height / 2 - refY
    const adx = Math.abs(dx)
    const ady = Math.abs(dy)

    let inCone: boolean
    let score: number
    if (dir === 'left') { inCone = dx < 0 && adx >= ady; score = adx + 2 * ady }
    else if (dir === 'right') { inCone = dx > 0 && adx >= ady; score = adx + 2 * ady }
    else if (dir === 'up') { inCone = dy < 0 && ady >= adx; score = ady + 2 * adx }
    else { inCone = dy > 0 && ady >= adx; score = ady + 2 * adx }
    if (!inCone) continue

    if (score < bestScore) {
      bestScore = score
      best = n
    }
  }
  return best
}

// -----------------------------------------------------------------------------
// Store factory — creates independent canvas store instances
// -----------------------------------------------------------------------------

export function createCanvasStore(): UseBoundStore<StoreApi<CanvasStore>> {
  // Each store instance gets its own zoom animation RAF tracking
  let activeZoomAnimationRafId = 0

  // Latest canvas-space pointer position (for anchoring ghost recommendations
  // to where the mouse is hovering). Kept off zustand state so high-frequency
  // mousemove updates never trigger re-renders.
  let lastPointerCanvasPos: Point | null = null

  function cancelZoomAnim() {
    if (activeZoomAnimationRafId) {
      cancelAnimationFrame(activeZoomAnimationRafId)
      activeZoomAnimationRafId = 0
    }
  }

  // Per-instance viewport-pan animation tracking. `offsetAnimTarget` is the
  // destination the tween is easing toward; tracking it (rather than reading
  // the mid-flight offset) lets rapid Shift+Arrow / Cmd+Arrow presses stack
  // smoothly instead of lagging behind the keystrokes.
  let activeOffsetAnimationRafId = 0
  let offsetAnimTarget: Point | null = null

  function cancelOffsetAnim() {
    if (activeOffsetAnimationRafId) {
      cancelAnimationFrame(activeOffsetAnimationRafId)
      activeOffsetAnimationRafId = 0
    }
    offsetAnimTarget = null
  }

  return create<CanvasStore>((set, get) => ({
  // --- State ---
  nodes: {},
  regions: {},
  viewportOffset: { x: 0, y: 0 },
  zoomLevel: ZOOM_DEFAULT,
  focusedNodeId: null,
  focusEpoch: 0,
  nextZOrder: 0,
  nextCreationIndex: 0,
  containerSize: { width: 0, height: 0 },
  snapGuides: { lines: [] },
  selectedNodeIds: new Set<string>(),
  selectedRegionIds: new Set<string>(),
  suppressAutoFocus: false,
  dropTargetRegionId: null,
  history: [],
  future: [],
  pendingPlacement: null,

  // --- Actions ---

  cancelZoomAnimation: cancelZoomAnim,

  pushHistory() {
    const state = get()
    const entry: CanvasHistoryEntry = {
      nodes: state.nodes,
      regions: state.regions,
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
      focusedNodeId: state.focusedNodeId,
    }
    set({
      nodes: prev.nodes,
      regions: prev.regions,
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
      focusedNodeId: state.focusedNodeId,
    }
    set({
      nodes: next.nodes,
      regions: next.regions,
      focusedNodeId: next.focusedNodeId,
      history: [...state.history, current],
      future: state.future.slice(0, -1),
    })
  },

  clearHistory() {
    set({ history: [], future: [] })
  },

  addNode(panelId, panelType, position?, size?) {
    // Canvas-on-canvas is unsupported and produces broken interaction (nested
    // zoom, ambiguous drag targets, duplicate stores keyed by the same id).
    // Refuse at the data layer regardless of which UI path tried it.
    if (panelType === 'canvas') {
      return ''
    }
    get().pushHistory()
    const state = get()
    const defaultSize = size ?? PANEL_DEFAULT_SIZES[panelType]
    // Dedupe on panelId: reposition + resize + focus the existing node.
    const existing = Object.values(state.nodes).find((n) => n.panelId === panelId)
    if (existing) {
      const { [existing.id]: _omit, ...otherNodes } = state.nodes
      const nextOrigin = findFreePosition(otherNodes, existing.id, defaultSize, position)
      set({
        nodes: {
          ...state.nodes,
          [existing.id]: {
            ...existing,
            origin: nextOrigin,
            size: defaultSize,
            zOrder: state.nextZOrder,
          },
        },
        nextZOrder: state.nextZOrder + 1,
        focusedNodeId: existing.id,
      })
      return existing.id
    }
    const nodeId = generateId()
    const origin = findFreePosition(state.nodes, state.focusedNodeId, defaultSize, position)

    const node: CanvasNodeState = {
      id: nodeId,
      panelId,
      origin,
      size: defaultSize,
      zOrder: state.nextZOrder,
      creationIndex: state.nextCreationIndex,
      animationState: IS_E2E ? 'idle' : 'entering',
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
        focusEpoch: state.focusEpoch + 1,
        // An explicit focus (click, switcher, auto-focus) ends keyboard-nav mode.
        suppressAutoFocus: false,
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
      focusEpoch: state.focusEpoch + 1,
    })
  },

  setZoom(level) {
    const clamped = Math.min(Math.max(level, ZOOM_MIN), ZOOM_MAX)
    set({ zoomLevel: clamped })
  },

  setViewportOffset(offset) {
    // A manual pan (wheel / drag) interrupts any in-flight keyboard tween and
    // resumes auto-focus-largest.
    cancelOffsetAnim()
    if (get().suppressAutoFocus) set({ viewportOffset: offset, suppressAutoFocus: false })
    else set({ viewportOffset: offset })
  },

  setZoomAndOffset(zoom, offset) {
    const clamped = Math.min(Math.max(zoom, ZOOM_MIN), ZOOM_MAX)
    set({ zoomLevel: clamped, viewportOffset: offset, suppressAutoFocus: false })
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
      suppressAutoFocus: false,
      viewportOffset: {
        x: centerView.x - centerCanvas.x * clamped,
        y: centerView.y - centerCanvas.y * clamped,
      },
    })
  },

  animateZoomTo(targetZoom) {
    cancelZoomAnim()
    cancelOffsetAnim()
    if (get().suppressAutoFocus) set({ suppressAutoFocus: false })

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

  animateViewportTo(target) {
    // A pan and a zoom-recentre must not both drive viewportOffset at once.
    cancelZoomAnim()
    offsetAnimTarget = target

    // No RAF (e.g. the node test environment) — apply instantly.
    if (typeof requestAnimationFrame !== 'function') {
      activeOffsetAnimationRafId = 0
      offsetAnimTarget = null
      set({ viewportOffset: target })
      return
    }

    // A loop is already running — it will glide to the updated target.
    if (activeOffsetAnimationRafId) return

    const EASE = 0.18
    const tick = () => {
      const t = offsetAnimTarget
      if (!t) { activeOffsetAnimationRafId = 0; return }
      const { viewportOffset: o } = get()
      const dx = t.x - o.x
      const dy = t.y - o.y
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
        set({ viewportOffset: { x: t.x, y: t.y } })
        activeOffsetAnimationRafId = 0
        offsetAnimTarget = null
        return
      }
      set({ viewportOffset: { x: o.x + dx * EASE, y: o.y + dy * EASE } })
      activeOffsetAnimationRafId = requestAnimationFrame(tick)
    }
    activeOffsetAnimationRafId = requestAnimationFrame(tick)
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
      focusEpoch: state.focusEpoch + 1,
    }
    if (cs.width > 0 && cs.height > 0) {
      newState.viewportOffset = {
        x: cs.width / 2 - (node.origin.x + node.size.width / 2) * zoom,
        y: cs.height / 2 - (node.origin.y + node.size.height / 2) * zoom,
      }
    }
    set(newState)
  },

  setPlacementPointer(point) {
    // Intentionally not via set() — this must not cause re-renders.
    lastPointerCanvasPos = point
  },

  beginPlacement(panelId, panelType, onCancelled) {
    const state = get()
    // Re-trigger while a placement is pending: latest wins. Roll the previous
    // pending panel back before replacing it so no orphan record lingers.
    const prev = state.pendingPlacement
    if (prev && prev.panelId !== panelId) {
      prev.onCancelled?.(prev.panelId)
    }
    const candidates = recommendPlacements(
      state.nodes,
      state.focusedNodeId,
      panelType,
      { offset: state.viewportOffset, zoom: state.zoomLevel, containerSize: state.containerSize },
      lastPointerCanvasPos,
    )
    if (candidates.length === 0) return false

    // Zoom out so every recommendation (plus the focused node for context) is
    // visible at once. Only ever zoom OUT — never further in.
    let nextZoom = state.zoomLevel
    let nextOffset = state.viewportOffset
    const cs = state.containerSize
    if (cs.width > 0 && cs.height > 0) {
      const rects: Rect[] = candidates.map((c) => ({ origin: c.point, size: c.size }))
      const focused = state.focusedNodeId ? state.nodes[state.focusedNodeId] : null
      if (focused) rects.push({ origin: focused.origin, size: focused.size })
      const minX = Math.min(...rects.map((r) => r.origin.x))
      const minY = Math.min(...rects.map((r) => r.origin.y))
      const maxX = Math.max(...rects.map((r) => r.origin.x + r.size.width))
      const maxY = Math.max(...rects.map((r) => r.origin.y + r.size.height))
      const padding = 80
      const contentW = maxX - minX + padding * 2
      const contentH = maxY - minY + padding * 2
      const fitZoom = Math.min(cs.width / contentW, cs.height / contentH)
      nextZoom = Math.min(Math.max(Math.min(state.zoomLevel, fitZoom), ZOOM_MIN), ZOOM_MAX)
      nextOffset = {
        x: (cs.width - contentW * nextZoom) / 2 - (minX - padding) * nextZoom,
        y: (cs.height - contentH * nextZoom) / 2 - (minY - padding) * nextZoom,
      }
    }

    set({
      pendingPlacement: {
        panelId,
        panelType,
        candidates,
        hoveredIndex: null,
        freeArmed: false,
        freeGhost: null,
        prevZoom: state.zoomLevel,
        prevOffset: state.viewportOffset,
        onCancelled,
      },
      zoomLevel: nextZoom,
      viewportOffset: nextOffset,
    })
    return true
  },

  commitPlacement(index) {
    const pending = get().pendingPlacement
    if (!pending) return null
    const candidate = pending.candidates[index]
    if (!candidate) return null
    // Restore the pre-placement zoom, drop the ghosts, then create + centre the
    // node at the chosen recommended spot.
    set({ pendingPlacement: null, zoomLevel: pending.prevZoom })
    const nodeId = get().addNode(pending.panelId, pending.panelType, candidate.point, candidate.size)
    if (!nodeId) return null
    get().focusAndCenter(nodeId)
    return nodeId
  },

  setFreeArmed(armed) {
    const pending = get().pendingPlacement
    if (!pending || pending.freeArmed === armed) return
    set({ pendingPlacement: { ...pending, freeArmed: armed, freeGhost: armed ? pending.freeGhost : null } })
  },

  updatePlacementCursor(point) {
    const pending = get().pendingPlacement
    if (!pending) return
    const size = PANEL_DEFAULT_SIZES[pending.panelType]
    const desired = { x: point.x - size.width / 2, y: point.y - size.height / 2 }
    const p = nudgeToFree(get().nodes, size, desired)
    const cur = pending.freeGhost
    if (cur && cur.point.x === p.x && cur.point.y === p.y) return
    set({ pendingPlacement: { ...pending, freeGhost: { point: p, size } } })
  },

  commitFreePlacement(point) {
    const pending = get().pendingPlacement
    if (!pending) return null
    const size = PANEL_DEFAULT_SIZES[pending.panelType]
    const desired = { x: point.x - size.width / 2, y: point.y - size.height / 2 }
    const p = nudgeToFree(get().nodes, size, desired)
    set({ pendingPlacement: null, zoomLevel: pending.prevZoom })
    const nodeId = get().addNode(pending.panelId, pending.panelType, p, size)
    if (!nodeId) return null
    get().focusAndCenter(nodeId)
    return nodeId
  },

  cancelPlacement() {
    const pending = get().pendingPlacement
    if (!pending) return
    // Restore the viewport we zoomed out from.
    set({ pendingPlacement: null, zoomLevel: pending.prevZoom, viewportOffset: pending.prevOffset })
    pending.onCancelled?.(pending.panelId)
  },

  setPlacementHover(index) {
    const pending = get().pendingPlacement
    if (!pending || pending.hoveredIndex === index) return
    set({ pendingPlacement: { ...pending, hoveredIndex: index } })
  },

  navigateDirection(dir) {
    const state = get()
    const nodeList = Object.values(state.nodes)
    if (nodeList.length === 0) return

    // Reference center: focused node's center, else the viewport center.
    const current = state.focusedNodeId ? state.nodes[state.focusedNodeId] : null
    let refX: number
    let refY: number
    if (current) {
      refX = current.origin.x + current.size.width / 2
      refY = current.origin.y + current.size.height / 2
    } else {
      const cs = state.containerSize
      const center = get().viewToCanvas({ x: cs.width / 2, y: cs.height / 2 })
      refX = center.x
      refY = center.y
    }

    const best = findNodeInDirection(nodeList, refX, refY, dir, current?.id)
    if (best) get().focusAndCenter(best.id)
  },

  navigateSelect(dir) {
    const state = get()
    const nodeList = Object.values(state.nodes)
    if (nodeList.length === 0) return

    // Reference center: the single selected node, else the focused node, else
    // the viewport center. Using selection (not focus) as the cursor lets the
    // user chain jumps without the destination grabbing keyboard focus.
    let ref: CanvasNodeState | null = null
    if (state.selectedNodeIds.size === 1) {
      const id = [...state.selectedNodeIds][0]
      ref = state.nodes[id] ?? null
    }
    if (!ref && state.focusedNodeId) ref = state.nodes[state.focusedNodeId] ?? null

    let refX: number
    let refY: number
    if (ref) {
      refX = ref.origin.x + ref.size.width / 2
      refY = ref.origin.y + ref.size.height / 2
    } else {
      const cs = state.containerSize
      const center = get().viewToCanvas({ x: cs.width / 2, y: cs.height / 2 })
      refX = center.x
      refY = center.y
    }

    const best = findNodeInDirection(nodeList, refX, refY, dir, ref?.id)
    if (!best) return

    // Select + raise the target and clear focus so no panel content grabs the
    // keyboard — otherwise the next arrow would be swallowed by the node
    // instead of moving to the one beyond it. The viewport then glides to
    // centre the node (see animateViewportTo) instead of snapping.
    set({
      nodes: { ...state.nodes, [best.id]: { ...best, zOrder: state.nextZOrder } },
      nextZOrder: state.nextZOrder + 1,
      selectedNodeIds: new Set([best.id]),
      selectedRegionIds: new Set<string>(),
      focusedNodeId: null,
      // Don't let auto-focus-largest re-activate a node as we pan to centre.
      suppressAutoFocus: true,
    })
    const cs = state.containerSize
    const zoom = state.zoomLevel
    if (cs.width > 0 && cs.height > 0) {
      get().animateViewportTo({
        x: cs.width / 2 - (best.origin.x + best.size.width / 2) * zoom,
        y: cs.height / 2 - (best.origin.y + best.size.height / 2) * zoom,
      })
    }
  },

  panViewport(dir) {
    // Panning the canvas by keyboard must not auto-activate nodes scrolling
    // into view.
    if (!get().suppressAutoFocus) set({ suppressAutoFocus: true })
    // Accumulate from the in-flight target (if animating) so repeated key
    // presses stack smoothly rather than chasing the easing tween.
    const o = offsetAnimTarget ?? get().viewportOffset
    // Arrow direction = direction the camera moves, so content scrolls the
    // opposite way (Down reveals what's below → offset.y decreases).
    const target =
      dir === 'up' ? { x: o.x, y: o.y + PAN_STEP }
      : dir === 'down' ? { x: o.x, y: o.y - PAN_STEP }
      : dir === 'left' ? { x: o.x + PAN_STEP, y: o.y }
      : { x: o.x - PAN_STEP, y: o.y }
    get().animateViewportTo(target)
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

  zoomToSelection() {
    const state = get()
    const cs = state.containerSize
    if (cs.width === 0 || cs.height === 0) return

    // Target the selection, else the focused node, else fall back to fit-all.
    let target = Object.values(state.nodes).filter((n) => state.selectedNodeIds.has(n.id))
    if (target.length === 0) {
      const focused = state.focusedNodeId ? state.nodes[state.focusedNodeId] : null
      if (focused) target = [focused]
    }
    if (target.length === 0) {
      get().zoomToFit()
      return
    }

    const minX = Math.min(...target.map(n => n.origin.x))
    const minY = Math.min(...target.map(n => n.origin.y))
    const maxX = Math.max(...target.map(n => n.origin.x + n.size.width))
    const maxY = Math.max(...target.map(n => n.origin.y + n.size.height))

    const padding = 60
    const contentW = maxX - minX + padding * 2
    const contentH = maxY - minY + padding * 2
    // Cap a single-node target so we don't over-zoom a small panel.
    const fitZoom = Math.min(cs.width / contentW, cs.height / contentH)
    const maxZoom = target.length === 1 ? Math.min(ZOOM_MAX, 1.5) : ZOOM_MAX
    const zoom = Math.min(Math.max(fitZoom, ZOOM_MIN), maxZoom)

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
      const nextNodes = additive ? new Set(state.selectedNodeIds) : new Set<string>()
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

    // Collect node IDs to remove (selected nodes + region contents if requested).
    // When NOT including region contents, exclude any selected node that lives
    // inside a selected region — selectRegions() cascades into the children, so
    // without this exclusion the "region only" path would still delete them.
    const nodeIdsToRemove = new Set(state.selectedNodeIds)
    if (!includeRegionContents && state.selectedRegionIds.size > 0) {
      for (const node of Object.values(state.nodes)) {
        if (node.regionId && state.selectedRegionIds.has(node.regionId)) {
          nodeIdsToRemove.delete(node.id)
        }
      }
    }
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
    const nodeList = Object.values(state.nodes).sort(
      (a, b) => a.creationIndex - b.creationIndex,
    )
    const regionList = Object.values(state.regions)
    if (nodeList.length === 0 && regionList.length === 0) {
      return
    }

    const containerWidth = state.containerSize.width > 0
      ? state.containerSize.width / state.zoomLevel
      : 1600
    const containerHeight = state.containerSize.height > 0
      ? state.containerSize.height / state.zoomLevel
      : 1000

    // Nodes-only path: uniform-size grid sized to the viewport.
    if (regionList.length === 0) {
      const gap = 6
      const n = nodeList.length
      const aspect = containerWidth / Math.max(containerHeight, 1)
      const cols = Math.max(1, Math.round(Math.sqrt(n * aspect)))
      const rows = Math.ceil(n / cols)
      const cellW = Math.max(
        240,
        (containerWidth - gap * (cols + 1)) / cols,
      )
      // Cap cell height by a panel-friendly aspect (≈ 4:3) so tall viewports
      // don't stretch panels vertically.
      const maxCellH = cellW * 0.72
      const cellH = Math.min(
        maxCellH,
        Math.max(160, (containerHeight - gap * (rows + 1)) / rows),
      )
      get().pushHistory()
      const updatedNodes = { ...state.nodes }
      nodeList.forEach((node, i) => {
        const col = i % cols
        const row = Math.floor(i / cols)
        updatedNodes[node.id] = {
          ...updatedNodes[node.id],
          origin: {
            x: gap + col * (cellW + gap),
            y: gap + row * (cellH + gap),
          },
          size: { width: cellW, height: cellH },
        }
      })
      set({ nodes: updatedNodes })
      get().zoomToFit()
      return
    }

    const result = computeAutoLayoutAll({
      nodes: nodeList,
      regions: regionList,
      containerWidth,
      containerHeight,
      gap: 40,
    })

    get().pushHistory()

    const updatedNodes = { ...state.nodes }
    for (const [id, origin] of Object.entries(result.nodeOrigins)) {
      if (updatedNodes[id]) updatedNodes[id] = { ...updatedNodes[id], origin }
    }

    const updatedRegions = { ...state.regions }
    for (const [id, origin] of Object.entries(result.regionOrigins)) {
      if (!updatedRegions[id]) continue
      const size = result.regionSizes[id] ?? updatedRegions[id].size
      updatedRegions[id] = { ...updatedRegions[id], origin, size }
    }

    set({
      nodes: updatedNodes,
      regions: updatedRegions,
    })

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
      color: color || REGION_FILL_COLORS[0],
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

  setRegionDefaultCwd(id, defaultCwd) {
    set((state) => {
      const region = state.regions[id]
      if (!region) return state
      return {
        regions: { ...state.regions, [id]: { ...region, defaultCwd } },
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

  groupSelectedHorizontal() {
    const state = get()
    const selectedNodes = Object.values(state.nodes).filter((n) => state.selectedNodeIds.has(n.id))
    if (selectedNodes.length === 0) return null

    get().pushHistory()

    const gap = 12
    const padding = 30
    const n = selectedNodes.length

    // Roughly-square grid: prefer slightly wider than tall.
    const cols = Math.ceil(Math.sqrt(n))
    const rows = Math.ceil(n / cols)

    // Normalize cell size to the median of the selection so the grid looks tidy.
    const median = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b)
      const m = Math.floor(s.length / 2)
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
    }
    const cellW = Math.round(median(selectedNodes.map((nd) => nd.size.width)))
    const cellH = Math.round(median(selectedNodes.map((nd) => nd.size.height)))

    // Anchor the grid at the top-left of the current selection bounds.
    const startX = Math.min(...selectedNodes.map((nd) => nd.origin.x))
    const startY = Math.min(...selectedNodes.map((nd) => nd.origin.y))

    // Preserve current visual order: sort row-major by (y, x).
    const sorted = [...selectedNodes].sort(
      (a, b) => a.origin.y - b.origin.y || a.origin.x - b.origin.x,
    )

    const regionId = get().addRegion(
      'Group',
      { x: startX - padding, y: startY - padding },
      {
        width: cols * cellW + (cols - 1) * gap + padding * 2,
        height: rows * cellH + (rows - 1) * gap + padding * 2,
      },
    )

    set((s) => {
      const updatedNodes = { ...s.nodes }
      sorted.forEach((nd, i) => {
        const col = i % cols
        const row = Math.floor(i / cols)
        updatedNodes[nd.id] = {
          ...updatedNodes[nd.id],
          origin: { x: startX + col * (cellW + gap), y: startY + row * (cellH + gap) },
          size: { width: cellW, height: cellH },
          regionId,
        }
      })
      return { nodes: updatedNodes }
    })

    return regionId
  },

  stackSelected(axis, gap = 16) {
    get().pushHistory()
    set((state) => {
      const selected = Object.values(state.nodes).filter((n) => state.selectedNodeIds.has(n.id))
      if (selected.length < 2) return state

      const row = axis === 'row'
      const sorted = [...selected].sort((a, b) =>
        row ? a.origin.x - b.origin.x : a.origin.y - b.origin.y,
      )
      // Anchor at the selection's top-left so the stack stays where the user
      // already placed it.
      const startX = Math.min(...selected.map((n) => n.origin.x))
      const startY = Math.min(...selected.map((n) => n.origin.y))

      const next = { ...state.nodes }
      let cursor = row ? startX : startY
      for (const n of sorted) {
        const x = row ? cursor : startX
        const y = row ? startY : cursor
        next[n.id] = { ...n, origin: { x, y } }
        cursor += (row ? n.size.width : n.size.height) + gap
      }
      return { nodes: next }
    })
  },

  tidyGridSelected(gap = 16) {
    get().pushHistory()
    set((state) => {
      const selected = Object.values(state.nodes).filter((n) => state.selectedNodeIds.has(n.id))
      if (selected.length < 2) return state

      const n = selected.length
      const cols = Math.ceil(Math.sqrt(n))

      // Use the max dimensions so nothing overlaps even with mixed sizes.
      const cellW = Math.max(...selected.map((nd) => nd.size.width))
      const cellH = Math.max(...selected.map((nd) => nd.size.height))

      const startX = Math.min(...selected.map((nd) => nd.origin.x))
      const startY = Math.min(...selected.map((nd) => nd.origin.y))

      // Preserve visual reading order: row-major by current (y, x).
      const sorted = [...selected].sort(
        (a, b) => a.origin.y - b.origin.y || a.origin.x - b.origin.x,
      )

      const next = { ...state.nodes }
      sorted.forEach((nd, i) => {
        const col = i % cols
        const row = Math.floor(i / cols)
        next[nd.id] = {
          ...nd,
          origin: { x: startX + col * (cellW + gap), y: startY + row * (cellH + gap) },
        }
      })
      return { nodes: next }
    })
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

  loadWorkspaceCanvas(nodes, viewportOffset, zoomLevel, focusedNodeId, regions) {
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
      viewportOffset,
      zoomLevel: Math.min(Math.max(zoomLevel, ZOOM_MIN), ZOOM_MAX),
      focusedNodeId,
      nextZOrder: maxZOrder + 1,
      nextCreationIndex: maxCreationIndex + 1,
      selectedNodeIds: new Set<string>(),
      selectedRegionIds: new Set<string>(),
      history: [],
      future: [],
      pendingPlacement: null,
    })
  },
}))
}

// -----------------------------------------------------------------------------
// Default singleton — backward-compatible during migration
// -----------------------------------------------------------------------------

export const useCanvasStore = createCanvasStore()

// -----------------------------------------------------------------------------
// Per-panel store registry — registration is delegated to the DragSession's
// canvasStores map. The session is the single source of truth for both
// panelId → store and nodeId → store lookups (the latter via a reverse index
// maintained by a store subscription). The local map below is kept for the
// returned `UseBoundStore` reference identity — the session stores a
// `StoreApi`, but consumers of this module hold `UseBoundStore` (`store(...)`).
// -----------------------------------------------------------------------------

import { getDefaultSession } from '../drag/session'

const canvasBoundStoresByPanelId = new Map<string, UseBoundStore<StoreApi<CanvasStore>>>()

export function getOrCreateCanvasStoreForPanel(
  panelId: string,
): UseBoundStore<StoreApi<CanvasStore>> {
  const existing = canvasBoundStoresByPanelId.get(panelId)
  if (existing) return existing
  // First panel to register inherits the legacy singleton — keeps session-
  // restore and sidebar code paths that read `useCanvasStore` working.
  const session = getDefaultSession()
  let store: UseBoundStore<StoreApi<CanvasStore>>
  if (session.getAllCanvasStores().length === 0) {
    store = useCanvasStore
  } else {
    store = createCanvasStore()
  }
  canvasBoundStoresByPanelId.set(panelId, store)
  session.registerCanvasStore(panelId, store)
  return store
}

export function releaseCanvasStoreForPanel(panelId: string): void {
  const store = canvasBoundStoresByPanelId.get(panelId)
  canvasBoundStoresByPanelId.delete(panelId)
  if (store) {
    getDefaultSession().releaseCanvasStore(panelId, store)
  }
}

/** Iterate every live CanvasStore (one per canvas panel currently mounted).
 *  Used by drag handlers to find the source canvas of a given node id. */
export function getAllCanvasStores(): UseBoundStore<StoreApi<CanvasStore>>[] {
  return Array.from(canvasBoundStoresByPanelId.values())
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

/**
 * Viewport-culled variant of useNodeIds. Only returns ids for nodes whose
 * bounding box intersects the visible canvas rect (expanded by a 1-screen
 * margin so panning doesn't thrash mount state at the edges). Focused and
 * pinned nodes are always included so they keep their live state.
 *
 * This is the primary lever for reducing memory/CPU when many terminals or
 * editors are open on a canvas — off-screen nodes don't mount at all.
 */
// z-order-sorted node list, cached by the `nodes` object identity. The cull
// selector below runs on EVERY store update — including every pan/zoom frame,
// where only viewportOffset/zoomLevel changed and `nodes` is the same object.
// Without this cache that path re-allocated Object.values() and re-sorted the
// whole node set 60×/s during a drag. zustand replaces `nodes` immutably on any
// real node change, so identity equality is a safe cache key; a WeakMap also
// keeps it correct across multiple per-panel canvas stores (and never leaks).
const sortedNodeCache = new WeakMap<object, CanvasNodeState[]>()
function sortedNodesByZOrder(nodes: Record<CanvasNodeId, CanvasNodeState>): CanvasNodeState[] {
  const cached = sortedNodeCache.get(nodes)
  if (cached) return cached
  perfCount('canvasCullSort')
  const sorted = Object.values(nodes).sort((a, b) => a.zOrder - b.zOrder)
  sortedNodeCache.set(nodes, sorted)
  return sorted
}

export function useVisibleNodeIds(store?: UseBoundStore<StoreApi<CanvasStore>>): string[] {
  return useStoreWithEqualityFn(
    store ?? useCanvasStore,
    (s) => {
      perfCount('canvasCullEval')
      const { nodes, viewportOffset, zoomLevel, containerSize, focusedNodeId } = s
      const z = zoomLevel
      const cw = containerSize.width
      const ch = containerSize.height

      const sorted = sortedNodesByZOrder(nodes)

      // Before the container size is known, render everything — prevents an
      // initial flash where no nodes appear while the ResizeObserver settles.
      if (cw === 0 || ch === 0 || z <= 0) {
        return sorted.map((n) => n.id)
      }

      // Visible canvas-space rect. worldTransform is scale(z) then
      // translate(offset/z), so a canvas point p maps to p*z + offset in view
      // space. Inverting: canvas = (view - offset) / z.
      const marginX = cw / z
      const marginY = ch / z
      const left = -viewportOffset.x / z - marginX
      const top = -viewportOffset.y / z - marginY
      const right = (cw - viewportOffset.x) / z + marginX
      const bottom = (ch - viewportOffset.y) / z + marginY

      const result: string[] = []
      for (const n of sorted) {
        if (n.id === focusedNodeId || n.isPinned) {
          result.push(n.id)
          continue
        }
        const nx = n.origin.x
        const ny = n.origin.y
        const nr = nx + n.size.width
        const nb = ny + n.size.height
        if (nr < left || nx > right || nb < top || ny > bottom) continue
        result.push(n.id)
      }
      return result
    },
    (a, b) => {
      if (a.length !== b.length) return false
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false
      }
      return true
    },
  )
}
