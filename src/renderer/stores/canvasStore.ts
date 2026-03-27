// =============================================================================
// Canvas Store — Zustand state for canvas nodes, viewport, and zoom.
// Ported from CanvasState.swift
// =============================================================================

import { create } from 'zustand'
import type {
  CanvasNodeId,
  CanvasNodeState,
  CanvasRegion,
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

// -----------------------------------------------------------------------------
// Store interface
// -----------------------------------------------------------------------------

interface CanvasStoreState {
  nodes: Record<CanvasNodeId, CanvasNodeState>
  regions: Record<string, CanvasRegion>
  viewportOffset: Point
  zoomLevel: number
  focusedNodeId: CanvasNodeId | null
  nextZOrder: number
  nextCreationIndex: number
  containerSize: Size
  snapGuides: { x: number | null; y: number | null }
}

interface CanvasStoreActions {
  // Mutations
  addNode: (
    panelId: string,
    panelType: PanelType,
    position?: Point,
    size?: Size,
  ) => CanvasNodeId
  removeNode: (id: CanvasNodeId) => void
  moveNode: (id: CanvasNodeId, origin: Point) => void
  resizeNode: (id: CanvasNodeId, size: Size, origin?: Point) => void
  focusNode: (id: CanvasNodeId) => void
  unfocus: () => void
  toggleMaximize: (id: CanvasNodeId, viewportSize: Size) => void
  setZoom: (level: number) => void
  setViewportOffset: (offset: Point) => void
  setContainerSize: (size: Size) => void
  zoomAroundCenter: (newZoom: number) => void

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

  setSnapGuides: (guides: { x: number | null; y: number | null }) => void
  clearSnapGuides: () => void

  autoLayout: () => void

  // Region management
  addRegion: (label: string, origin: Point, size: Size, color?: string) => string
  removeRegion: (id: string) => void
  moveRegion: (id: string, origin: Point) => void
  resizeRegion: (id: string, size: Size, origin?: Point) => void
  renameRegion: (id: string, label: string) => void

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

/** Find a free position near the focused node or last node. */
function findFreePosition(
  nodes: Record<CanvasNodeId, CanvasNodeState>,
  focusedNodeId: CanvasNodeId | null,
  defaultSize: Size,
): Point {
  const nodeList = Object.values(nodes)
  if (nodeList.length === 0) {
    return { x: 100, y: 100 }
  }

  // Prefer placing near the focused node, otherwise near the last node
  let reference: CanvasNodeState | undefined
  if (focusedNodeId && nodes[focusedNodeId]) {
    reference = nodes[focusedNodeId]
  } else {
    reference = nodeList[nodeList.length - 1]
  }

  if (!reference) {
    return { x: 100, y: 100 }
  }

  // Try placing to the right with a 40px gap
  const gap = 40
  const candidate: Point = {
    x: reference.origin.x + reference.size.width + gap,
    y: reference.origin.y,
  }

  // Check for overlap with existing nodes
  const candidateRect = {
    origin: candidate,
    size: defaultSize,
  }

  const overlaps = nodeList.some((n) => rectsOverlap(
    { origin: n.origin, size: n.size },
    candidateRect,
  ))

  if (!overlaps) return candidate

  // Fall back: stack below with a 40px gap
  return {
    x: reference.origin.x,
    y: reference.origin.y + reference.size.height + gap,
  }
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
// Store
// -----------------------------------------------------------------------------

export const useCanvasStore = create<CanvasStore>((set, get) => ({
  // --- State ---
  nodes: {},
  regions: {},
  viewportOffset: { x: 0, y: 0 },
  zoomLevel: ZOOM_DEFAULT,
  focusedNodeId: null,
  nextZOrder: 0,
  nextCreationIndex: 0,
  containerSize: { width: 0, height: 0 },
  snapGuides: { x: null, y: null },

  // --- Actions ---

  addNode(panelId, panelType, position?, size?) {
    const state = get()
    const nodeId = generateId()
    const defaultSize = size ?? PANEL_DEFAULT_SIZES[panelType]
    const origin = position ?? findFreePosition(state.nodes, state.focusedNodeId, defaultSize)

    const node: CanvasNodeState = {
      id: nodeId,
      panelId,
      origin,
      size: defaultSize,
      zOrder: state.nextZOrder,
      creationIndex: state.nextCreationIndex,
    }

    set({
      nodes: { ...state.nodes, [nodeId]: node },
      nextZOrder: state.nextZOrder + 1,
      nextCreationIndex: state.nextCreationIndex + 1,
    })

    return nodeId
  },

  removeNode(id) {
    set((state) => {
      const { [id]: _removed, ...remaining } = state.nodes
      return {
        nodes: remaining,
        focusedNodeId: state.focusedNodeId === id ? null : state.focusedNodeId,
      }
    })
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
      // Save current geometry and maximize to fill visible viewport
      const topLeft = get().viewToCanvas({ x: 0, y: 0 })
      const bottomRight = get().viewToCanvas({
        x: viewportSize.width,
        y: viewportSize.height,
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
    set({ snapGuides: { x: null, y: null } })
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
        if (rectsOverlap(
          { origin: node.origin, size: node.size },
          { origin: region.origin, size: region.size },
        )) {
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

  loadWorkspaceCanvas(nodes, viewportOffset, zoomLevel, focusedNodeId, regions) {
    // Compute next counters from loaded data
    const nodeList = Object.values(nodes)
    const maxZOrder = nodeList.reduce((max, n) => Math.max(max, n.zOrder), -1)
    const maxCreationIndex = nodeList.reduce((max, n) => Math.max(max, n.creationIndex), -1)

    set({
      nodes,
      regions: regions ?? {},
      viewportOffset,
      zoomLevel: Math.min(Math.max(zoomLevel, ZOOM_MIN), ZOOM_MAX),
      focusedNodeId,
      nextZOrder: maxZOrder + 1,
      nextCreationIndex: maxCreationIndex + 1,
    })
  },
}))
