// A split drawn as a flex row or column at its ratios. Dragging a divider
// draws the new ratios locally every frame and commits them once at the end.

import React, { useCallback, useRef, useState } from 'react'
import type { DockNode, DockSplit } from '@workspace/document/contract'
import { clampSplitDelta, layoutMinimum, SPLIT_DIVIDER_SIZE, type PanelTypeOf } from './sizing'
import { DockResizeHandle } from './DockResizeHandle'

interface DockSplitContainerProps {
  node: DockSplit
  renderNode: (node: DockNode) => React.ReactNode
  typeOf?: PanelTypeOf
  /** Commits a divider gesture's final ratios. */
  onRatios?: (splitId: string, ratios: number[]) => void
}

export function DockSplitContainer({ node, renderNode, typeOf, onRatios }: DockSplitContainerProps) {
  const isHorizontal = node.direction === 'horizontal'
  const containerRef = useRef<HTMLDivElement>(null)
  const [live, setLive] = useState<number[] | null>(null)
  const ratios = live && live.length === node.children.length ? live : node.ratios
  // The handle keeps the handler from mousedown; read ratios through a ref so
  // they do not go stale mid-gesture.
  const ratiosRef = useRef(ratios)
  ratiosRef.current = ratios

  const handleResize = useCallback((index: number, delta: number) => {
    const container = containerRef.current
    if (!container) return
    const containerSize = isHorizontal ? container.offsetWidth : container.offsetHeight
    if (containerSize <= 0) return
    const count = node.children.length
    const available = containerSize - SPLIT_DIVIDER_SIZE * (count - 1)
    const panes = Array.from(container.children).filter((child) => child.hasAttribute('data-dock-pane')) as HTMLElement[]
    const measured = panes.map((pane) => (isHorizontal ? pane.offsetWidth : pane.offsetHeight) / available)
    // Minimums may hold panes above their saved ratios after a window resize:
    // start from what is on screen.
    const current = measured.length === count && measured.every((ratio) => ratio > 0)
      ? measured.map((ratio) => ratio / measured.reduce((sum, value) => sum + value, 0))
      : ratiosRef.current
    const clamped = clampSplitDelta({ ...node, ratios: current }, index, delta / available, containerSize, typeOf)
    const next = [...current]
    next[index] = current[index] + clamped
    next[index + 1] = current[index + 1] - clamped
    ratiosRef.current = next
    setLive(next)
  }, [node, isHorizontal, typeOf])

  const handleResizeEnd = useCallback(() => {
    const final = ratiosRef.current
    setLive(null)
    if (final !== node.ratios) onRatios?.(node.id, final)
  }, [node, onRatios])

  return (
    <div ref={containerRef} className={`flex h-full w-full min-h-0 min-w-0 ${isHorizontal ? 'flex-row' : 'flex-col'}`}>
      {node.children.map((child, i) => {
        const minimum = layoutMinimum(child, typeOf)
        return (
          <React.Fragment key={child.id}>
            <div
              data-dock-pane={child.id}
              style={{
                [isHorizontal ? 'width' : 'height']: `calc((100% - ${SPLIT_DIVIDER_SIZE * (node.children.length - 1)}px) * ${ratios[i]})`,
                minWidth: minimum.width,
                minHeight: minimum.height,
              }}
              className="shrink overflow-hidden"
            >
              {renderNode(child)}
            </div>
            {i < node.children.length - 1 && (
              <DockResizeHandle
                direction={isHorizontal ? 'horizontal' : 'vertical'}
                onResize={(delta) => handleResize(i, delta)}
                onResizeEnd={handleResizeEnd}
              />
            )}
          </React.Fragment>
        )
      })}
    </div>
  )
}
