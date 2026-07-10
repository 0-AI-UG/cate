// =============================================================================
// Defensive guard for canvas geometry loaded from `<project>/.cate`.
//
// Persisted node data can be corrupt, half-written, or from an older schema. The
// restore path seeds the canvas store directly from it, so a single node missing
// `size`/`origin` used to crash the entire canvas render with an opaque
// "Cannot read properties of undefined (reading 'width')" (CanvasNode's selector
// and useNodeResize both read `node.size.width`).
//
// We repair what we safely can (origin, size, z-order/creation counters) and
// drop only the unrecoverable (not an object, or no `panelId` — a node that
// can't address a panel can't render). The result is reported so callers can log
// it.
// =============================================================================

import type { CanvasNodeId, CanvasNodeState, DockLayoutNode, Point, Size } from '../../../shared/types'

// Generic recovery geometry. We don't have the node's panel type here (it lives
// on the PanelState, not the node), so a sensible mid-size default is the safe
// floor — comfortably above every panel type's minimum.
const FALLBACK_SIZE: Size = { width: 640, height: 400 }
const FALLBACK_ORIGIN: Point = { x: 0, y: 0 }

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

export function isValidPoint(p: unknown): p is Point {
  return (
    !!p &&
    typeof p === 'object' &&
    isFiniteNumber((p as Point).x) &&
    isFiniteNumber((p as Point).y)
  )
}

export function isValidSize(s: unknown): s is Size {
  return (
    !!s &&
    typeof s === 'object' &&
    isFiniteNumber((s as Size).width) &&
    (s as Size).width > 0 &&
    isFiniteNumber((s as Size).height) &&
    (s as Size).height > 0
  )
}

function isValidDockLayout(value: unknown): value is DockLayoutNode {
  if (!value || typeof value !== 'object') return false
  const layout = value as Partial<DockLayoutNode>
  if (typeof layout.id !== 'string' || !layout.id) return false
  if (layout.type === 'tabs') {
    return (
      Array.isArray(layout.panelIds) &&
      layout.panelIds.length > 0 &&
      layout.panelIds.every((id) => typeof id === 'string' && id.length > 0) &&
      Number.isInteger(layout.activeIndex) &&
      (layout.activeIndex as number) >= 0 &&
      (layout.activeIndex as number) < layout.panelIds.length
    )
  }
  if (layout.type === 'split') {
    return (
      (layout.direction === 'horizontal' || layout.direction === 'vertical') &&
      Array.isArray(layout.children) &&
      layout.children.length > 0 &&
      layout.children.every(isValidDockLayout) &&
      Array.isArray(layout.ratios) &&
      layout.ratios.length === layout.children.length &&
      layout.ratios.every((ratio) => isFiniteNumber(ratio) && ratio > 0)
    )
  }
  return false
}

export interface SanitizeResult {
  nodes: Record<CanvasNodeId, CanvasNodeState>
  /** Ids of nodes that were kept but had one or more fields repaired. */
  repaired: string[]
  /** Keys/ids of nodes that were dropped as unrecoverable. */
  dropped: string[]
}

/** Validate and repair a `canvasNodes` map read from persisted workspace state.
 *  Never throws; returns a clean map plus what was changed. */
export function sanitizeLoadedCanvasNodes(
  raw: Record<string, unknown> | null | undefined,
): SanitizeResult {
  const nodes: Record<CanvasNodeId, CanvasNodeState> = {}
  const repaired: string[] = []
  const dropped: string[] = []
  if (!raw || typeof raw !== 'object') return { nodes, repaired, dropped }

  // Backfill any missing z-order/creation counters past the highest valid ones,
  // so repaired nodes stack on top and keep a stable creation order.
  let nextZ = 0
  let nextC = 0
  for (const value of Object.values(raw)) {
    if (!value || typeof value !== 'object') continue
    const { zOrder, creationIndex } = value as Partial<CanvasNodeState>
    if (isFiniteNumber(zOrder)) nextZ = Math.max(nextZ, zOrder + 1)
    if (isFiniteNumber(creationIndex)) nextC = Math.max(nextC, creationIndex + 1)
  }

  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') {
      dropped.push(key)
      continue
    }
    const v = value as Partial<CanvasNodeState>
    if (!isValidDockLayout(v.dockLayout)) {
      dropped.push(key)
      continue
    }

    let touched = false
    const repair = <T>(ok: boolean, good: T, fallback: T): T => {
      if (ok) return good
      touched = true
      return fallback
    }

    // Key by the map key and normalize node.id to match — the rest of the canvas
    // code treats the store key and node.id as the same identity.
    const node: CanvasNodeState = {
      ...(v as CanvasNodeState),
      id: key,
      dockLayout: v.dockLayout,
      origin: repair(isValidPoint(v.origin), v.origin as Point, { ...FALLBACK_ORIGIN }),
      size: repair(isValidSize(v.size), v.size as Size, { ...FALLBACK_SIZE }),
      zOrder: repair(isFiniteNumber(v.zOrder), v.zOrder as number, nextZ++),
      creationIndex: repair(isFiniteNumber(v.creationIndex), v.creationIndex as number, nextC++),
    }

    // A maximized node carries pre-maximize geometry that resize/restore code
    // reads; if it's malformed, drop it back to a normal (un-maximized) node
    // rather than risk a second crash.
    if (node.preMaximizeOrigin != null && !isValidPoint(node.preMaximizeOrigin)) {
      delete node.preMaximizeOrigin
      touched = true
    }
    if (node.preMaximizeSize != null && !isValidSize(node.preMaximizeSize)) {
      delete node.preMaximizeSize
      touched = true
    }

    nodes[key] = node
    if (touched) repaired.push(key)
  }

  return { nodes, repaired, dropped }
}
