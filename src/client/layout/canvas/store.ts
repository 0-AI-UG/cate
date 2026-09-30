// The client view of one canvas (architecture 5, 13.5): the document's nodes
// with this client's z-order, pins, animation state and gesture previews laid
// over them, plus viewport, zoom, selection, snap guides, the marquee and the
// pending panel target. Only moves, resizes and arrangement reach the
// document, each as one `setNodeRects` op when the gesture ends; everything
// else here is client state and never leaves this client.
//
// `nodes` keeps its identity across pan and zoom frames and every node object
// keeps its identity until that node changes, so selectors and memoised node
// views skip work.

import { createStore, type StoreApi } from 'zustand/vanilla'
import {
  autoLayout as autoLayoutRects,
  boundingRect,
  canvasToView as canvasToViewPoint,
  findFreePosition,
  findNodeInDirection,
  nudgeToFree,
  recommendPlacements,
  sameRect,
  stackRects,
  tidyGridRects,
  viewToCanvas as viewToCanvasPoint,
  type Direction,
  type NodeRect,
  type PlacementCandidate,
  type Point,
  type Rect,
  type Size,
} from '@workspace/canvas/contract'
import type { CanvasModel } from '@workspace/canvas/contract'
import {
  dockPanels,
  dockStacks,
  type DocBatch,
  type DocChange,
  type DockNode,
  type NodeId,
  type PanelId,
  type PlaceTarget,
  type WorkspaceDocument,
} from '@workspace/document/contract'
import type { ClientState, Viewport } from '@client/document'
import { clampZoom, PAN_STEP, ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN } from './constants'
import { canvasHost, panelDefaultSize } from './ports'
import { focusedNodeId, withLead } from './selection'
import { zoomEaseForElapsed } from './parts/zoomAnimation'

// --- State ---------------------------------------------------------------------

export type NodeAnimation = 'entering' | 'exiting' | 'idle'

/** A canvas node as this client shows it. `rect`, `origin` and `size` are the
 *  same objects (`origin === rect.origin`), so a ViewNode is also a `Box`. */
export interface ViewNode {
  id: NodeId
  rect: Rect
  origin: Point
  size: Size
  dock: DockNode
  /** Stacking order on this client; higher is in front. */
  zOrder: number
  /** Position in the document's record order (creation order). */
  creationIndex: number
  /** Locked on this client: no drag, no resize. */
  isPinned: boolean
  animationState: NodeAnimation
}

export interface SnapGuideLine {
  axis: 'x' | 'y'
  position: number
  type: 'edge' | 'center'
}

export interface Marquee {
  startX: number
  startY: number
  currentX: number
  currentY: number
}

export type PanelTargetAvailability = 'new' | 'existing' | 'both'

export type CanvasPanelTargetChoice =
  | { kind: 'new'; point: Point; size: Size }
  | { kind: 'existing'; panelId: PanelId }

export interface PanelTargetRequest {
  /** A record the caller already created; a new spot is handed to `place`. */
  panelId?: PanelId
  place?: (point: Point | undefined, size: Size) => NodeId | null
  panelType: string
  availability: PanelTargetAvailability
  existing: { panelId: PanelId; title: string }[]
  onSelected?: (choice: CanvasPanelTargetChoice) => void
  onCancelled: () => void
  size?: Size
}

export interface PendingPanelTarget {
  panelId?: PanelId
  place?: PanelTargetRequest['place']
  panelType: string
  availability: PanelTargetAvailability
  candidates: PlacementCandidate[]
  existing: { panelId: PanelId; nodeId: NodeId; title: string }[]
  hoveredIndex: number | null
  freeArmed: boolean
  freeGhost: { point: Point; size: Size } | null
  size: Size
  prevZoom: number
  prevOffset: Point
  onSelected?: (choice: CanvasPanelTargetChoice) => void
  onCancelled: () => void
}

export interface CanvasViewState {
  readonly workspaceId: string
  readonly canvasId: string
  nodes: Record<NodeId, ViewNode>
  viewportOffset: Point
  zoomLevel: number
  containerSize: Size
  /** Ordered selection, lead last. See selection.ts. */
  selection: NodeId[]
  selectionActive: boolean
  /** Increases on every activation, so re-focusing the same node is visible. */
  focusEpoch: number
  /** Each node's active-tab worktree, published by the node view. */
  nodeActiveWorktreeId: Record<NodeId, string | null>
  snapGuides: { lines: SnapGuideLine[] }
  /** Keyboard movement (Cmd+Arrow, Shift+Arrow) holds off auto-focus. */
  suppressAutoFocus: boolean
  pendingPanelTarget: PendingPanelTarget | null
  marquee: Marquee | null
  /** Rects of a gesture in progress, sent as one op when it ends. */
  preview: Record<NodeId, Rect>
}

export interface CanvasViewActions {
  // Viewport
  cancelZoomAnimation(): void
  setZoom(level: number): void
  setViewportOffset(offset: Point): void
  setZoomAndOffset(zoom: number, offset: Point): void
  setContainerSize(size: Size): void
  zoomAroundCenter(zoom: number): void
  animateZoomTo(zoom: number): void
  animateViewportTo(target: Point): void
  canvasToView(point: Point): Point
  viewToCanvas(point: Point): Point
  viewFrame(nodeId: NodeId): Rect | null
  zoomToFit(): void
  zoomToSelection(): void

  // Geometry: previews apply locally each frame; commit sends one op.
  moveNode(nodeId: NodeId, origin: Point): void
  resizeNode(nodeId: NodeId, size: Size, origin?: Point): void
  previewRects(rects: readonly NodeRect[]): void
  clearPreview(): void
  /** Sends the previewed rects as one `setNodeRects` op. */
  commitPreview(): void
  /** Sends rects as one `setNodeRects` op (drops, arrangement). */
  setNodeRects(rects: readonly NodeRect[]): boolean

  // Focus, stacking, pins
  focusNode(nodeId: NodeId): void
  unfocus(): void
  focusAndCenter(nodeId: NodeId): void
  moveToFront(nodeId: NodeId): void
  moveToBack(nodeId: NodeId): void
  togglePin(nodeId: NodeId): void
  setNodeAnimationState(nodeId: NodeId, state: NodeAnimation): void
  /** Drops a node whose exit animation finished. */
  finalizeRemoveNode(nodeId: NodeId): void
  setNodeActiveWorktree(nodeId: NodeId, worktreeId: string | null): void
  nodeForPanel(panelId: PanelId): NodeId | null
  sortedNodesByCreationOrder(): ViewNode[]
  nextNode(): NodeId | null
  previousNode(): NodeId | null

  // Selection and overlays
  selectNodes(ids: readonly NodeId[], additive?: boolean): void
  clearSelection(): void
  selectAll(): void
  toggleNodeSelection(nodeId: NodeId): void
  /** Closes every panel of the selected nodes, through the host's confirms. */
  deleteSelection(): Promise<void>
  setSnapGuides(guides: { lines: SnapGuideLine[] }): void
  clearSnapGuides(): void
  setMarquee(marquee: Marquee | null): void

  // Keyboard navigation
  navigateDirection(dir: Direction): void
  navigateSelect(dir: Direction): void
  panViewport(dir: Direction): void

  // Arrangement: one op each
  autoLayout(): void
  stackSelected(axis: 'row' | 'column', gap?: number): void
  tidyGridSelected(gap?: number): void

  // Placement on this canvas
  /** A canvas target for a new node of `size`: at `position` when free (or
   *  exactly there with `exact`), else the free spot next to the focus. */
  placeTarget(size: Size, options?: { position?: Point; exact?: boolean }): Extract<PlaceTarget, { to: 'canvas' }>
  /** Moves a panel onto this canvas as a new node with one `placePanel`.
   *  Returns the node id, or null when the op failed. */
  placePanel(panelId: PanelId, options?: { size?: Size; position?: Point; exact?: boolean; focus?: boolean }): NodeId | null

  // Interactive panel target
  setPlacementPointer(point: Point | null): void
  refreshPlacement(): void
  setFreeArmed(armed: boolean): void
  updatePlacementCursor(point: Point): void
  commitFreePlacement(point: Point): NodeId | null
  setPlacementHover(index: number | null): void
  beginPanelTarget(request: PanelTargetRequest): boolean
  selectNewPanelTarget(index: number): NodeId | null
  selectExistingPanelTarget(panelId: PanelId): void
  cancelPanelTarget(): void

  dispose(): void
}

export type CanvasView = CanvasViewState & CanvasViewActions
export type CanvasViewStore = StoreApi<CanvasView>

// --- Dependencies ---------------------------------------------------------------

/** The part of a client document store the view uses (`DocumentStore`
 *  satisfies it). */
export interface CanvasDocumentSource {
  getSnapshot(): WorkspaceDocument
  subscribe(listener: () => void): () => void
  propose(change: DocChange | DocBatch): { ok: boolean }
}

/** The part of the client state store the view mirrors into. */
export interface CanvasClientStateSink {
  getSnapshot(): ClientState
  focus(panelId: PanelId | null): void
  setSelection(canvasId: string, nodeIds: readonly NodeId[]): void
  setViewport(canvasId: string, viewport: Viewport): void
}

export interface CanvasViewOptions {
  workspaceId: string
  canvasId: string
  document: CanvasDocumentSource
  clientState?: CanvasClientStateSink | null
  /** Node enter/exit animations. Off under e2e, where hidden windows
   *  throttle rAF and a stalled enter animation would skew hit-testing. */
  animate?: boolean
  newId?: () => string
}

// --- Helpers --------------------------------------------------------------------

const EMPTY_TABS: Readonly<Record<string, PanelId>> = {}

/** The panel a node shows first: the active tab of its first stack. */
export function activeNodePanelId(dock: DockNode | null | undefined, activeTabs: Readonly<Record<string, PanelId>> = EMPTY_TABS): PanelId | null {
  const stack = dockStacks(dock)[0]
  if (!stack) return null
  const active = activeTabs[stack.id]
  return active && stack.panels.includes(active) ? active : stack.panels[0] ?? null
}

function viewNode(id: NodeId, rect: Rect, dock: DockNode, zOrder: number, creationIndex: number, isPinned: boolean, animationState: NodeAnimation): ViewNode {
  return { id, rect, origin: rect.origin, size: rect.size, dock, zOrder, creationIndex, isPinned, animationState }
}

function fitRects(rects: readonly Rect[], container: Size, padding: number, maxZoom: number, capAt?: number): { zoom: number; offset: Point } | null {
  const bounds = boundingRect(rects)
  if (!bounds || container.width <= 0 || container.height <= 0) return null
  const width = bounds.size.width + padding * 2
  const height = bounds.size.height + padding * 2
  let fit = Math.min(container.width / width, container.height / height)
  if (capAt !== undefined) fit = Math.min(fit, capAt)
  const zoom = Math.min(Math.max(fit, ZOOM_MIN), maxZoom)
  return {
    zoom,
    offset: {
      x: (container.width - width * zoom) / 2 - (bounds.origin.x - padding) * zoom,
      y: (container.height - height * zoom) / 2 - (bounds.origin.y - padding) * zoom,
    },
  }
}

const EXIT_KEEP_MS = 200
const VIEWPORT_MIRROR_MS = 250

// --- Factory ----------------------------------------------------------------------

export function createCanvasView(options: CanvasViewOptions): CanvasViewStore {
  const { workspaceId, canvasId, document } = options
  const clientState = options.clientState ?? null
  const animate = options.animate ?? true
  const newId = options.newId ?? (() => globalThis.crypto.randomUUID())

  // Client-only bookkeeping, outside the reactive state.
  const zOrders = new Map<NodeId, number>()
  let nextZOrder = 0
  const pinned = new Set<NodeId>()
  let lastCanvas: CanvasModel | undefined
  let lastPanels: WorkspaceDocument['panels'] | undefined
  let synced = false
  let zoomRaf = 0
  let offsetRaf = 0
  let offsetTarget: Point | null = null
  let pointer: Point | null = null
  let syncDocument: () => void = () => {}

  const cancelZoomAnim = () => {
    if (zoomRaf) cancelAnimationFrame(zoomRaf)
    zoomRaf = 0
  }
  const cancelOffsetAnim = () => {
    if (offsetRaf) cancelAnimationFrame(offsetRaf)
    offsetRaf = 0
    offsetTarget = null
  }

  const initialViewport = clientState?.getSnapshot().viewports[canvasId]

  const store = createStore<CanvasView>()((set, get) => {
    // Rebuild `nodes` from the document, the preview and client bookkeeping,
    // reusing every node object that did not change.
    const derive = (doc: WorkspaceDocument, preview: Record<NodeId, Rect>): Partial<CanvasViewState> | null => {
      const state = get()
      const canvas = doc.canvases[canvasId]
      const prev = state.nodes
      const next: Record<NodeId, ViewNode> = {}
      let changed = false
      let index = 0
      for (const [id, node] of Object.entries(canvas?.nodes ?? {})) {
        let z = zOrders.get(id)
        if (z === undefined) {
          z = nextZOrder++
          zOrders.set(id, z)
        }
        const rect = preview[id] ?? node.rect
        const old = prev[id]
        const animation: NodeAnimation = old
          ? (old.animationState === 'exiting' ? 'idle' : old.animationState)
          : (synced && animate ? 'entering' : 'idle')
        const isPinned = pinned.has(id)
        if (
          old && old.dock === node.dock && old.zOrder === z && old.creationIndex === index
          && old.isPinned === isPinned && old.animationState === animation
          && (old.rect === rect || sameRect(old.rect, rect))
        ) {
          next[id] = old
        } else {
          next[id] = viewNode(id, rect, node.dock, z, index, isPinned, animation)
          changed = true
        }
        index++
      }
      // A node whose panels were closed plays its exit; one whose panels moved
      // elsewhere (dragged into another node) goes at once.
      for (const [id, old] of Object.entries(prev)) {
        if (next[id]) continue
        const closed = animate && dockPanels(old.dock).every((panelId) => !doc.panels[panelId])
        if (closed) {
          next[id] = old.animationState === 'exiting' ? old : { ...old, animationState: 'exiting' }
          if (old.animationState !== 'exiting') {
            changed = true
            setTimeout(() => get().finalizeRemoveNode(id), EXIT_KEEP_MS)
          }
        } else {
          zOrders.delete(id)
          pinned.delete(id)
          changed = true
        }
      }
      if (!changed) return null
      const patch: Partial<CanvasViewState> = { nodes: next }
      const live = (id: NodeId) => !!next[id] && next[id].animationState !== 'exiting'
      if (state.selection.some((id) => !live(id))) {
        const wasActive = focusedNodeId(state)
        patch.selection = state.selection.filter(live)
        if (wasActive && !live(wasActive)) patch.selectionActive = false
      }
      return patch
    }

    syncDocument = () => {
      const doc = document.getSnapshot()
      const canvas = doc.canvases[canvasId]
      if (synced && canvas === lastCanvas && doc.panels === lastPanels) return
      lastCanvas = canvas
      lastPanels = doc.panels
      const patch = derive(doc, get().preview)
      synced = true
      if (patch) set(patch)
    }
    const sync = () => syncDocument()

    const setPreview = (preview: Record<NodeId, Rect>) => {
      const patch = derive(document.getSnapshot(), preview)
      set({ ...(patch ?? {}), preview })
    }

    const propose = (change: DocChange): boolean => {
      const ok = document.propose(change).ok
      sync()
      return ok
    }

    const activePanelOf = (nodeId: NodeId): PanelId | null => {
      const node = get().nodes[nodeId]
      if (!node) return null
      return activeNodePanelId(node.dock, clientState?.getSnapshot().activeTabs)
    }

    const raise = (nodeId: NodeId): Partial<CanvasViewState> | null => {
      const node = get().nodes[nodeId]
      if (!node) return null
      const z = nextZOrder++
      zOrders.set(nodeId, z)
      return { nodes: { ...get().nodes, [nodeId]: { ...node, zOrder: z } } }
    }

    const centerOn = (node: ViewNode): Point | null => {
      const { containerSize: cs, zoomLevel: zoom } = get()
      if (cs.width <= 0 || cs.height <= 0) return null
      return {
        x: cs.width / 2 - (node.origin.x + node.size.width / 2) * zoom,
        y: cs.height / 2 - (node.origin.y + node.size.height / 2) * zoom,
      }
    }

    const liveNodes = (): ViewNode[] => Object.values(get().nodes).filter((n) => n.animationState !== 'exiting')
    const liveBoxes = (): Record<NodeId, ViewNode> => {
      const out: Record<NodeId, ViewNode> = {}
      for (const n of liveNodes()) out[n.id] = n
      return out
    }
    const selectedNodes = (): ViewNode[] => {
      const { nodes, selection } = get()
      return selection.flatMap((id) => (nodes[id] && nodes[id].animationState !== 'exiting' ? [nodes[id]] : []))
    }

    // --- Panel target helpers ---
    const computeCandidates = (size: Size): PlacementCandidate[] => {
      const s = get()
      return recommendPlacements(
        liveBoxes(),
        focusedNodeId(s),
        size,
        { offset: s.viewportOffset, zoom: s.zoomLevel, containerSize: s.containerSize },
        pointer,
      )
    }
    const existingRects = (pending: PendingPanelTarget): Rect[] => {
      const { nodes } = get()
      return [...new Set(pending.existing.map((c) => c.nodeId))].flatMap((id) => (nodes[id] ? [nodes[id].rect] : []))
    }
    const fitCamera = (candidates: PlacementCandidate[], existing: Rect[]): { zoom: number; offset: Point } => {
      const s = get()
      const rects: Rect[] = [...candidates.map((c) => ({ origin: c.point, size: c.size })), ...existing]
      if (candidates.length > 0) {
        const focused = focusedNodeId(s)
        if (focused && s.nodes[focused]) rects.push(s.nodes[focused].rect)
      }
      const fit = fitRects(rects, s.containerSize, 80, ZOOM_MAX, s.zoomLevel)
      return fit ?? { zoom: s.zoomLevel, offset: s.viewportOffset }
    }
    const endTarget = (pending: PendingPanelTarget, keepOffset: boolean) => {
      set(keepOffset
        ? { pendingPanelTarget: null, zoomLevel: pending.prevZoom }
        : { pendingPanelTarget: null, zoomLevel: pending.prevZoom, viewportOffset: pending.prevOffset })
    }
    const finishNewTarget = (pending: PendingPanelTarget, point: Point, size: Size): NodeId | null => {
      if (pending.place) {
        // The creator places and focuses the node, so the camera stays put.
        endTarget(pending, true)
        return pending.place(point, size)
      }
      endTarget(pending, false)
      pending.onSelected?.({ kind: 'new', point, size })
      return null
    }
    const beginTarget = (request: PanelTargetRequest & { size: Size }): boolean => {
      const s = get()
      const candidates = request.availability !== 'existing' ? computeCandidates(request.size) : []
      const nodes = liveNodes()
      const existing = request.availability !== 'new'
        ? request.existing.flatMap((c) => {
          const node = nodes.find((n) => dockPanels(n.dock).includes(c.panelId))
          return node ? [{ ...c, nodeId: node.id }] : []
        })
        : []
      if (candidates.length === 0 && existing.length === 0) return false
      const pending: PendingPanelTarget = {
        panelId: request.panelId,
        place: request.place,
        panelType: request.panelType,
        availability: request.availability,
        candidates,
        existing,
        hoveredIndex: null,
        freeArmed: false,
        freeGhost: null,
        size: request.size,
        prevZoom: s.zoomLevel,
        prevOffset: s.viewportOffset,
        onSelected: request.onSelected,
        onCancelled: request.onCancelled,
      }
      const camera = fitCamera(candidates, existingRects(pending))
      set({ pendingPanelTarget: pending, zoomLevel: camera.zoom, viewportOffset: camera.offset })
      return true
    }

    const findRef = (preferSelection: boolean): { ref: ViewNode | null; point: Point } => {
      const s = get()
      let ref: ViewNode | null = null
      if (preferSelection && s.selection.length === 1) ref = s.nodes[s.selection[0]] ?? null
      const focused = focusedNodeId(s)
      if (!ref && focused) ref = s.nodes[focused] ?? null
      if (ref) return { ref, point: { x: ref.origin.x + ref.size.width / 2, y: ref.origin.y + ref.size.height / 2 } }
      const cs = s.containerSize
      return { ref: null, point: get().viewToCanvas({ x: cs.width / 2, y: cs.height / 2 }) }
    }

    return {
      workspaceId,
      canvasId,
      nodes: {},
      viewportOffset: initialViewport ? { x: initialViewport.x, y: initialViewport.y } : { x: 0, y: 0 },
      zoomLevel: initialViewport ? clampZoom(initialViewport.zoom) : ZOOM_DEFAULT,
      containerSize: { width: 0, height: 0 },
      selection: [],
      selectionActive: false,
      focusEpoch: 0,
      nodeActiveWorktreeId: {},
      snapGuides: { lines: [] },
      suppressAutoFocus: false,
      pendingPanelTarget: null,
      marquee: null,
      preview: {},

      // --- Viewport ---
      cancelZoomAnimation: cancelZoomAnim,

      setZoom(level) {
        set({ zoomLevel: clampZoom(level) })
      },

      setViewportOffset(offset) {
        // A manual pan interrupts a keyboard glide and resumes auto-focus.
        cancelOffsetAnim()
        set(get().suppressAutoFocus ? { viewportOffset: offset, suppressAutoFocus: false } : { viewportOffset: offset })
      },

      setZoomAndOffset(zoom, offset) {
        set({ zoomLevel: clampZoom(zoom), viewportOffset: offset, suppressAutoFocus: false })
      },

      setContainerSize(size) {
        const previous = get().containerSize
        if (previous.width === size.width && previous.height === size.height) return
        set({ containerSize: size })
        // A canvas revealed after a target request refits once it has a size.
        if (size.width > 0 && size.height > 0) get().refreshPlacement()
      },

      zoomAroundCenter(zoom) {
        const s = get()
        const clamped = clampZoom(zoom)
        if (clamped === s.zoomLevel) return
        const cs = s.containerSize
        if (cs.width === 0 || cs.height === 0) {
          set({ zoomLevel: clamped })
          return
        }
        const center = { x: cs.width / 2, y: cs.height / 2 }
        const anchor = viewToCanvasPoint(center, s.zoomLevel, s.viewportOffset)
        set({
          zoomLevel: clamped,
          suppressAutoFocus: false,
          viewportOffset: { x: center.x - anchor.x * clamped, y: center.y - anchor.y * clamped },
        })
      },

      animateZoomTo(targetZoom) {
        cancelZoomAnim()
        cancelOffsetAnim()
        if (get().suppressAutoFocus) set({ suppressAutoFocus: false })
        const target = clampZoom(targetZoom)
        let lastFrameAt = performance.now()
        const step = (zoom: number) => {
          const s = get()
          const cx = (s.containerSize.width || window.innerWidth) / 2
          const cy = (s.containerSize.height || window.innerHeight) / 2
          const anchor = viewToCanvasPoint({ x: cx, y: cy }, s.zoomLevel, s.viewportOffset)
          set({ zoomLevel: zoom, viewportOffset: { x: cx - anchor.x * zoom, y: cy - anchor.y * zoom } })
        }
        const tick = (now: number) => {
          const diff = target - get().zoomLevel
          if (Math.abs(diff) < 0.001) {
            step(target)
            zoomRaf = 0
            return
          }
          const ease = zoomEaseForElapsed(now - lastFrameAt)
          lastFrameAt = now
          step(get().zoomLevel + diff * ease)
          zoomRaf = requestAnimationFrame(tick)
        }
        zoomRaf = requestAnimationFrame(tick)
      },

      animateViewportTo(target) {
        // A pan and a zoom recentre must not both drive the offset.
        cancelZoomAnim()
        offsetTarget = target
        if (typeof requestAnimationFrame !== 'function') {
          offsetRaf = 0
          offsetTarget = null
          set({ viewportOffset: target })
          return
        }
        if (offsetRaf) return
        const EASE = 0.18
        const tick = () => {
          const t = offsetTarget
          if (!t) { offsetRaf = 0; return }
          const o = get().viewportOffset
          const dx = t.x - o.x
          const dy = t.y - o.y
          if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
            set({ viewportOffset: { x: t.x, y: t.y } })
            offsetRaf = 0
            offsetTarget = null
            return
          }
          set({ viewportOffset: { x: o.x + dx * EASE, y: o.y + dy * EASE } })
          offsetRaf = requestAnimationFrame(tick)
        }
        offsetRaf = requestAnimationFrame(tick)
      },

      canvasToView(point) {
        const { zoomLevel, viewportOffset } = get()
        return canvasToViewPoint(point, zoomLevel, viewportOffset)
      },

      viewToCanvas(point) {
        const { zoomLevel, viewportOffset } = get()
        return viewToCanvasPoint(point, zoomLevel, viewportOffset)
      },

      viewFrame(nodeId) {
        const { nodes, zoomLevel } = get()
        const node = nodes[nodeId]
        if (!node) return null
        return {
          origin: get().canvasToView(node.origin),
          size: { width: node.size.width * zoomLevel, height: node.size.height * zoomLevel },
        }
      },

      zoomToFit() {
        const fit = fitRects(liveNodes().map((n) => n.rect), get().containerSize, 60, ZOOM_MAX)
        if (fit) set({ zoomLevel: fit.zoom, viewportOffset: fit.offset })
      },

      zoomToSelection() {
        const s = get()
        let target = selectedNodes()
        if (target.length === 0) {
          const focused = focusedNodeId(s)
          if (focused && s.nodes[focused]) target = [s.nodes[focused]]
        }
        if (target.length === 0) {
          get().zoomToFit()
          return
        }
        // Cap a single node so a small panel is not blown up.
        const maxZoom = target.length === 1 ? Math.min(ZOOM_MAX, 1.5) : ZOOM_MAX
        const fit = fitRects(target.map((n) => n.rect), s.containerSize, 60, maxZoom)
        if (fit) set({ zoomLevel: fit.zoom, viewportOffset: fit.offset })
      },

      // --- Geometry ---
      moveNode(nodeId, origin) {
        const node = get().nodes[nodeId]
        if (!node) return
        setPreview({ ...get().preview, [nodeId]: { origin, size: node.size } })
      },

      resizeNode(nodeId, size, origin) {
        const node = get().nodes[nodeId]
        if (!node) return
        setPreview({ ...get().preview, [nodeId]: { origin: origin ?? node.origin, size } })
      },

      previewRects(rects) {
        const preview = { ...get().preview }
        for (const { nodeId, rect } of rects) if (get().nodes[nodeId]) preview[nodeId] = rect
        setPreview(preview)
      },

      clearPreview() {
        if (Object.keys(get().preview).length > 0) setPreview({})
      },

      commitPreview() {
        const doc = document.getSnapshot().canvases[canvasId]
        const rects = Object.entries(get().preview).flatMap(([nodeId, rect]) => {
          const current = doc?.nodes[nodeId]?.rect
          return current && !sameRect(current, rect) ? [{ nodeId, rect }] : []
        })
        if (rects.length > 0) document.propose({ kind: 'setNodeRects', canvasId, rects })
        setPreview({})
      },

      setNodeRects(rects) {
        if (rects.length === 0) return true
        return propose({ kind: 'setNodeRects', canvasId, rects: rects.map((r) => ({ nodeId: r.nodeId, rect: r.rect })) })
      },

      // --- Focus, stacking, pins ---
      focusNode(nodeId) {
        const raised = raise(nodeId)
        if (!raised) return
        set({
          ...raised,
          selection: [nodeId],
          selectionActive: true,
          focusEpoch: get().focusEpoch + 1,
          // An explicit focus ends keyboard-navigation mode.
          suppressAutoFocus: false,
        })
        clientState?.focus(activePanelOf(nodeId))
      },

      unfocus() {
        // Deactivate the lead but keep the rings.
        set({ selectionActive: false })
      },

      focusAndCenter(nodeId) {
        const raised = raise(nodeId)
        if (!raised) return
        const offset = centerOn(get().nodes[nodeId])
        set({
          ...raised,
          selection: [nodeId],
          selectionActive: true,
          focusEpoch: get().focusEpoch + 1,
          ...(offset ? { viewportOffset: offset } : {}),
        })
        clientState?.focus(activePanelOf(nodeId))
      },

      moveToFront(nodeId) {
        const raised = raise(nodeId)
        if (raised) set(raised)
      },

      moveToBack(nodeId) {
        const node = get().nodes[nodeId]
        if (!node) return
        const min = Math.min(...Object.values(get().nodes).map((n) => n.zOrder))
        zOrders.set(nodeId, min - 1)
        set({ nodes: { ...get().nodes, [nodeId]: { ...node, zOrder: min - 1 } } })
      },

      togglePin(nodeId) {
        const node = get().nodes[nodeId]
        if (!node) return
        if (pinned.has(nodeId)) pinned.delete(nodeId)
        else pinned.add(nodeId)
        set({ nodes: { ...get().nodes, [nodeId]: { ...node, isPinned: pinned.has(nodeId) } } })
      },

      setNodeAnimationState(nodeId, animationState) {
        const node = get().nodes[nodeId]
        if (!node || node.animationState === animationState) return
        set({ nodes: { ...get().nodes, [nodeId]: { ...node, animationState } } })
      },

      finalizeRemoveNode(nodeId) {
        const node = get().nodes[nodeId]
        if (!node || node.animationState !== 'exiting') return
        const { [nodeId]: _gone, ...nodes } = get().nodes
        zOrders.delete(nodeId)
        pinned.delete(nodeId)
        set({ nodes })
      },

      setNodeActiveWorktree(nodeId, worktreeId) {
        const current = get().nodeActiveWorktreeId
        if (current[nodeId] === worktreeId) return
        if (worktreeId === null && !(nodeId in current)) return
        const next = { ...current }
        if (worktreeId === null) delete next[nodeId]
        else next[nodeId] = worktreeId
        set({ nodeActiveWorktreeId: next })
      },

      nodeForPanel(panelId) {
        return liveNodes().find((n) => dockPanels(n.dock).includes(panelId))?.id ?? null
      },

      sortedNodesByCreationOrder() {
        return liveNodes().sort((a, b) => a.creationIndex - b.creationIndex)
      },

      nextNode() {
        const sorted = get().sortedNodesByCreationOrder()
        if (sorted.length === 0) return null
        const index = sorted.findIndex((n) => n.id === focusedNodeId(get()))
        return index === -1 ? sorted[0].id : sorted[(index + 1) % sorted.length].id
      },

      previousNode() {
        const sorted = get().sortedNodesByCreationOrder()
        if (sorted.length === 0) return null
        const index = sorted.findIndex((n) => n.id === focusedNodeId(get()))
        return index === -1 ? sorted[sorted.length - 1].id : sorted[(index - 1 + sorted.length) % sorted.length].id
      },

      // --- Selection and overlays ---
      // Pure selection never activates, so a marquee cannot leave a node
      // looking active while outside the moved set.
      selectNodes(ids, additive) {
        if (additive) {
          let next = get().selection
          for (const id of ids) next = withLead(next, id)
          set({ selection: next, selectionActive: false })
          return
        }
        set({ selection: [...new Set(ids)], selectionActive: false })
      },

      clearSelection() {
        set({ selection: [], selectionActive: false })
      },

      selectAll() {
        set({ selection: liveNodes().map((n) => n.id), selectionActive: false })
      },

      toggleNodeSelection(nodeId) {
        const s = get().selection
        set({ selection: s.includes(nodeId) ? s.filter((x) => x !== nodeId) : [...s, nodeId], selectionActive: false })
      },

      async deleteSelection() {
        const panelIds = new Set<PanelId>()
        for (const node of selectedNodes()) for (const id of dockPanels(node.dock)) panelIds.add(id)
        if (panelIds.size === 0) return
        const closed = await canvasHost().closePanels(workspaceId, [...panelIds]).catch(() => false)
        if (closed) set({ selectionActive: false })
      },

      setSnapGuides(guides) {
        set({ snapGuides: guides })
      },

      clearSnapGuides() {
        if (get().snapGuides.lines.length > 0) set({ snapGuides: { lines: [] } })
      },

      setMarquee(marquee) {
        set({ marquee })
      },

      // --- Keyboard navigation ---
      navigateDirection(dir) {
        const { ref, point } = findRef(false)
        const best = findNodeInDirection(liveNodes(), point, dir, ref?.id)
        if (best) get().focusAndCenter(best.id)
      },

      navigateSelect(dir) {
        const { ref, point } = findRef(true)
        const best = findNodeInDirection(liveNodes(), point, dir, ref?.id)
        if (!best) return
        // Select without activating so no panel grabs the keyboard and the next
        // arrow keeps navigating; the viewport glides to centre it.
        const raised = raise(best.id)
        set({ ...(raised ?? {}), selection: [best.id], selectionActive: false, suppressAutoFocus: true })
        const offset = centerOn(get().nodes[best.id])
        if (offset) get().animateViewportTo(offset)
      },

      panViewport(dir) {
        if (!get().suppressAutoFocus) set({ suppressAutoFocus: true })
        // Stack from the glide target so repeated presses do not chase it.
        const o = offsetTarget ?? get().viewportOffset
        // The camera moves in the arrow's direction, so content moves the other way.
        const target =
          dir === 'up' ? { x: o.x, y: o.y + PAN_STEP }
          : dir === 'down' ? { x: o.x, y: o.y - PAN_STEP }
          : dir === 'left' ? { x: o.x + PAN_STEP, y: o.y }
          : { x: o.x - PAN_STEP, y: o.y }
        get().animateViewportTo(target)
      },

      // --- Arrangement ---
      autoLayout() {
        const s = get()
        const area = {
          width: s.containerSize.width > 0 ? s.containerSize.width / s.zoomLevel : 0,
          height: s.containerSize.height > 0 ? s.containerSize.height / s.zoomLevel : 0,
        }
        const rects = autoLayoutRects(get().sortedNodesByCreationOrder(), area)
        if (rects.length === 0) return
        get().setNodeRects(rects)
        get().zoomToFit()
      },

      stackSelected(axis, gap = 16) {
        get().setNodeRects(stackRects(selectedNodes(), axis, gap))
      },

      tidyGridSelected(gap = 16) {
        get().setNodeRects(tidyGridRects(selectedNodes(), gap))
      },

      // --- Placement ---
      placeTarget(size, placeOptions = {}) {
        const nodes = liveBoxes()
        const { position, exact } = placeOptions
        const origin = position && exact
          ? position
          : position
            ? nudgeToFree(nodes, size, position)
            : findFreePosition(nodes, focusedNodeId(get()), size)
        return { to: 'canvas', canvasId, nodeId: newId(), stackId: newId(), rect: { origin, size } }
      },

      placePanel(panelId, placeOptions = {}) {
        const type = document.getSnapshot().panels[panelId]?.type
        const size = placeOptions.size ?? panelDefaultSize(type)
        const at = get().placeTarget(size, placeOptions)
        if (!propose({ kind: 'placePanel', id: panelId, at })) return null
        if (placeOptions.focus !== false) get().focusNode(at.nodeId)
        return at.nodeId
      },

      // --- Interactive panel target ---
      setPlacementPointer(point) {
        pointer = point
      },

      refreshPlacement() {
        const pending = get().pendingPanelTarget
        if (!pending || pending.freeArmed) return
        const candidates = pending.availability === 'existing' ? [] : computeCandidates(pending.size)
        if (candidates.length === 0 && pending.existing.length === 0) return
        const camera = fitCamera(candidates, existingRects(pending))
        set({ pendingPanelTarget: { ...pending, candidates, hoveredIndex: null }, zoomLevel: camera.zoom, viewportOffset: camera.offset })
      },

      setFreeArmed(armed) {
        const pending = get().pendingPanelTarget
        if (!pending || pending.availability === 'existing' || pending.freeArmed === armed) return
        set({ pendingPanelTarget: { ...pending, freeArmed: armed, freeGhost: armed ? pending.freeGhost : null } })
      },

      updatePlacementCursor(point) {
        const pending = get().pendingPanelTarget
        if (!pending || pending.availability === 'existing') return
        const desired = { x: point.x - pending.size.width / 2, y: point.y - pending.size.height / 2 }
        const placed = nudgeToFree(liveBoxes(), pending.size, desired)
        const current = pending.freeGhost
        if (current && current.point.x === placed.x && current.point.y === placed.y) return
        set({ pendingPanelTarget: { ...pending, freeGhost: { point: placed, size: pending.size } } })
      },

      commitFreePlacement(point) {
        const pending = get().pendingPanelTarget
        if (!pending || pending.availability === 'existing') return null
        const desired = { x: point.x - pending.size.width / 2, y: point.y - pending.size.height / 2 }
        return finishNewTarget(pending, nudgeToFree(liveBoxes(), pending.size, desired), pending.size)
      },

      setPlacementHover(index) {
        const pending = get().pendingPanelTarget
        if (!pending || pending.hoveredIndex === index) return
        set({ pendingPanelTarget: { ...pending, hoveredIndex: index } })
      },

      beginPanelTarget(request) {
        const previous = get().pendingPanelTarget
        if (previous) {
          endTarget(previous, false)
          if (!request.panelId || previous.panelId !== request.panelId) previous.onCancelled()
        }
        const s = get()
        const size = request.size ?? panelDefaultSize(request.panelType)
        // An empty canvas has nothing to choose between: place at the centre.
        if (request.place && request.availability === 'new' && liveNodes().length === 0) {
          const cs = s.containerSize
          const center = cs.width > 0 && cs.height > 0 ? get().viewToCanvas({ x: cs.width / 2, y: cs.height / 2 }) : null
          const origin = center ? { x: center.x - size.width / 2, y: center.y - size.height / 2 } : undefined
          return request.place(origin, size) !== null
        }
        return beginTarget({ ...request, size })
      },

      selectNewPanelTarget(index) {
        const pending = get().pendingPanelTarget
        const candidate = pending?.candidates[index]
        if (!pending || !candidate) return null
        return finishNewTarget(pending, candidate.point, candidate.size)
      },

      selectExistingPanelTarget(panelId) {
        const pending = get().pendingPanelTarget
        if (!pending?.existing.some((c) => c.panelId === panelId)) return
        endTarget(pending, false)
        pending.onSelected?.({ kind: 'existing', panelId })
      },

      cancelPanelTarget() {
        const pending = get().pendingPanelTarget
        if (!pending) return
        endTarget(pending, false)
        pending.onCancelled()
      },

      dispose() {
        cancelZoomAnim()
        cancelOffsetAnim()
        stopDocument()
        stopMirror()
      },
    }
  })

  // --- Wiring ---
  syncDocument()
  const stopDocument = document.subscribe(syncDocument)

  // Mirror viewport (once it settles) and selection into the client state.
  let viewportTimer: ReturnType<typeof setTimeout> | undefined
  const stopMirror = clientState
    ? store.subscribe((state, prev) => {
      if (state.selection !== prev.selection) clientState.setSelection(canvasId, state.selection)
      if (state.zoomLevel !== prev.zoomLevel || state.viewportOffset !== prev.viewportOffset) {
        if (viewportTimer) clearTimeout(viewportTimer)
        viewportTimer = setTimeout(() => {
          viewportTimer = undefined
          const s = store.getState()
          clientState.setViewport(canvasId, { x: s.viewportOffset.x, y: s.viewportOffset.y, zoom: s.zoomLevel })
        }, VIEWPORT_MIRROR_MS)
      }
    })
    : () => {}

  return store
}
