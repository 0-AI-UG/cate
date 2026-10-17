// Bulk arrangement. Each function returns the new rects, ready to send as one
// `setNodeRects` op; nodes it does not move are left out.

import type { Box, Rect, Size } from './geometry'

export interface NodeRect {
  nodeId: string
  rect: Rect
}

/** Lay every node out in a uniform grid sized to the visible area
 *  (`area` in canvas units; the viewport divided by zoom). Nodes keep their
 *  record order, which is creation order. */
export function autoLayout(nodes: readonly Box[], area: Size): NodeRect[] {
  if (nodes.length === 0) return []
  const containerWidth = area.width > 0 ? area.width : 1600
  const containerHeight = area.height > 0 ? area.height : 1000

  const gap = 6
  const n = nodes.length
  const aspect = containerWidth / Math.max(containerHeight, 1)
  const cols = Math.max(1, Math.round(Math.sqrt(n * aspect)))
  const rows = Math.ceil(n / cols)
  const cellW = Math.max(240, (containerWidth - gap * (cols + 1)) / cols)
  // Cap the cell height near 4:3 so a tall viewport does not stretch panels.
  const maxCellH = cellW * 0.72
  const cellH = Math.min(maxCellH, Math.max(160, (containerHeight - gap * (rows + 1)) / rows))

  return nodes.map((node, i) => ({
    nodeId: node.id,
    rect: {
      origin: { x: gap + (i % cols) * (cellW + gap), y: gap + Math.floor(i / cols) * (cellH + gap) },
      size: { width: cellW, height: cellH },
    },
  }))
}

/** Line nodes up in a row (left to right) or a column (top to bottom),
 *  anchored at their current top-left so the stack stays where it was. */
export function stackRects(nodes: readonly Box[], axis: 'row' | 'column', gap = 16): NodeRect[] {
  if (nodes.length < 2) return []
  const row = axis === 'row'
  const sorted = [...nodes].sort((a, b) =>
    row ? a.rect.origin.x - b.rect.origin.x : a.rect.origin.y - b.rect.origin.y,
  )
  const startX = Math.min(...nodes.map((n) => n.rect.origin.x))
  const startY = Math.min(...nodes.map((n) => n.rect.origin.y))

  let cursor = row ? startX : startY
  return sorted.map((n) => {
    const origin = row ? { x: cursor, y: startY } : { x: startX, y: cursor }
    cursor += (row ? n.rect.size.width : n.rect.size.height) + gap
    return { nodeId: n.id, rect: { origin, size: n.rect.size } }
  })
}

/** Tidy nodes into a near-square grid in reading order (by y, then x). Cells
 *  take the largest width and height so mixed sizes never overlap. */
export function tidyGridRects(nodes: readonly Box[], gap = 16): NodeRect[] {
  if (nodes.length < 2) return []
  const cols = Math.ceil(Math.sqrt(nodes.length))
  const cellW = Math.max(...nodes.map((n) => n.rect.size.width))
  const cellH = Math.max(...nodes.map((n) => n.rect.size.height))
  const startX = Math.min(...nodes.map((n) => n.rect.origin.x))
  const startY = Math.min(...nodes.map((n) => n.rect.origin.y))

  const sorted = [...nodes].sort(
    (a, b) => a.rect.origin.y - b.rect.origin.y || a.rect.origin.x - b.rect.origin.x,
  )
  return sorted.map((n, i) => ({
    nodeId: n.id,
    rect: {
      origin: { x: startX + (i % cols) * (cellW + gap), y: startY + Math.floor(i / cols) * (cellH + gap) },
      size: n.rect.size,
    },
  }))
}
