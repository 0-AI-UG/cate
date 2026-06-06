// =============================================================================
// DockSplitContainer — flex container with children at specified ratios.
// Renders split layout nodes recursively.
// =============================================================================

import React, { useCallback, useRef } from 'react'
import { useDockStoreContext } from '../stores/DockStoreContext'
import type { DockSplitNode } from '../../shared/types'
import DockResizeHandle from './DockResizeHandle'

interface DockSplitContainerProps {
  node: DockSplitNode
  renderNode: (node: import('../../shared/types').DockLayoutNode) => React.ReactNode
}

export default function DockSplitContainer({
  node,
  renderNode,
}: DockSplitContainerProps) {
  const setSplitRatio = useDockStoreContext((s) => s.setSplitRatio)
  const isHorizontal = node.direction === 'horizontal'
  const containerRef = useRef<HTMLDivElement>(null)

  // Use a ref to avoid stale closure: the drag handler in DockResizeHandle
  // captures onResize at mousedown time, so node.ratios in a useCallback
  // dependency would go stale during the drag, causing wobble.
  const ratiosRef = useRef(node.ratios)
  ratiosRef.current = node.ratios

  const handleResize = useCallback(
    (index: number, delta: number) => {
      const container = containerRef.current
      if (!container) return
      const containerSize = isHorizontal ? container.offsetWidth : container.offsetHeight
      if (containerSize <= 0) return

      const currentRatios = ratiosRef.current
      const ratioDelta = delta / containerSize
      const newRatios = [...currentRatios]
      const minRatio = 0.1

      // Clamp so neither panel goes below minRatio, then transfer
      // only the actual change between the two adjacent panels.
      // Other panels stay untouched (no re-normalization).
      const a = currentRatios[index]
      const b = currentRatios[index + 1]
      const clampedDelta = Math.max(minRatio - a, Math.min(b - minRatio, ratioDelta))
      newRatios[index] = a + clampedDelta
      newRatios[index + 1] = b - clampedDelta

      setSplitRatio(node.id, newRatios)
    },
    [node.id, isHorizontal, setSplitRatio],
  )

  return (
    <div
      ref={containerRef}
      className={`flex h-full w-full min-h-0 min-w-0 ${isHorizontal ? 'flex-row' : 'flex-col'}`}
    >
      {node.children.map((child, i) => {
        return (
        <React.Fragment key={child.type === 'tabs' ? child.id : child.id}>
          <div
            style={{
              [isHorizontal ? 'width' : 'height']: `${node.ratios[i] * 100}%`,
            }}
            className="min-h-0 min-w-0 overflow-hidden"
          >
            {renderNode(child)}
          </div>
          {i < node.children.length - 1 && (
            <DockResizeHandle
              direction={isHorizontal ? 'horizontal' : 'vertical'}
              onResize={(delta) => handleResize(i, delta)}
            />
          )}
        </React.Fragment>
        )
      })}
    </div>
  )
}
