// A layout's symbol on its chip: its split tree drawn small, one box per pane. While the layout is shown, its
// focused pane (or the first, when focus is elsewhere) takes the accent; otherwise every pane is grey.

import React from 'react'
import { dockStacks, type DockNode, type StackId } from '@workspace/document/contract'

export interface GlyphBox { stackId: StackId | null; x: number; y: number; width: number; height: number }

/** The panes of a dock tree laid out in a `width` x `height` box, `gap` apart, sized by the tree's ratios. An empty
 *  layout is one blank pane. */
export function glyphBoxes(dock: DockNode | null, width: number, height: number, gap: number): GlyphBox[] {
  const place = (node: DockNode, x: number, y: number, w: number, h: number): GlyphBox[] => {
    if (node.kind === 'stack') return [{ stackId: node.id, x, y, width: w, height: h }]
    const horizontal = node.direction === 'horizontal'
    const room = (horizontal ? w : h) - gap * (node.children.length - 1)
    let at = horizontal ? x : y
    return node.children.flatMap((child, i) => {
      const size = room * node.ratios[i]
      const boxes = horizontal ? place(child, at, y, size, h) : place(child, x, at, w, size)
      at += size + gap
      return boxes
    })
  }
  return dock ? place(dock, 0, 0, width, height) : [{ stackId: null, x: 0, y: 0, width, height }]
}

const W = 16
const H = 12

export function LayoutGlyph({ dock, shown, focused, size = 14 }: { dock: DockNode | null; shown: boolean; focused?: string | null; size?: number }) {
  const boxes = glyphBoxes(dock, W, H, 1.5)
  const active = !shown ? undefined : (focused && dockStacks(dock).find((stack) => stack.panels.includes(focused))?.id) || boxes[0].stackId
  return (
    <svg width={size * W / H} height={size} viewBox={`0 0 ${W} ${H}`} aria-hidden className="shrink-0 overflow-visible">
      {boxes.map((box) => (
        <rect
          key={box.stackId ?? 'empty'}
          x={box.x} y={box.y} width={box.width} height={box.height} rx={1.5}
          fill={box.stackId === active ? 'var(--focus-blue, #3b82f6)' : 'currentColor'}
          opacity={box.stackId === active ? 1 : 0.45}
        />
      ))}
    </svg>
  )
}
