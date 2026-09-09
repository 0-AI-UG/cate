// =============================================================================
// DockSplitContainer — flex container with children at specified ratios.
// Renders split layout nodes recursively.
// =============================================================================

import React, { useCallback, useRef } from 'react'
import { useDockStoreContext } from '../stores/DockStoreContext'
import { type DockLayoutNode, type DockSplitNode, type PanelType } from '../../shared/types'
import { findTabStack } from '../stores/dockTreeUtils'
import { layoutMinimum, SPLIT_DIVIDER_SIZE } from './splitSizing'
import DockResizeHandle from './DockResizeHandle'

interface DockSplitContainerProps {
  node: DockSplitNode
  renderNode: (node: DockLayoutNode) => React.ReactNode
  getPanelType?: (panelId: string) => PanelType | undefined
}

export function clampSplitDelta(
  node: DockSplitNode,
  index: number,
  ratioDelta: number,
  containerSize: number,
  getPanelType?: (panelId: string) => PanelType | undefined,
): number {
  const dimension = node.direction === 'horizontal' ? 'width' : 'height'
  const available = containerSize - SPLIT_DIVIDER_SIZE * (node.children.length - 1)
  const a = node.ratios[index]
  const b = node.ratios[index + 1]
  const minA = layoutMinimum(node.children[index], getPanelType)[dimension] / available
  const minB = layoutMinimum(node.children[index + 1], getPanelType)[dimension] / available
  if (minA + minB > a + b) return 0
  const lowerBound = minA - a
  const upperBound = b - minB

  return Math.max(lowerBound, Math.min(upperBound, ratioDelta))
}

export default function DockSplitContainer({
  node,
  renderNode,
  getPanelType,
}: DockSplitContainerProps) {
  const setSplitRatio = useDockStoreContext((s) => s.setSplitRatio)
  const maximizedStackId = useDockStoreContext((s) => s.maximizedStackId)
  const containsMaximized = !!maximizedStackId && !!findTabStack(node, maximizedStackId)
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
      const ratioDelta = delta / (containerSize - SPLIT_DIVIDER_SIZE * (node.children.length - 1))
      const newRatios = [...currentRatios]

      // Clamp so canvas panes respect their declared minimum dimensions and
      // other panes retain the existing 10% floor, then transfer
      // only the actual change between the two adjacent panels.
      // Other panels stay untouched (no re-normalization).
      const a = currentRatios[index]
      const b = currentRatios[index + 1]
      const clampedDelta = clampSplitDelta({ ...node, ratios: currentRatios }, index, ratioDelta, containerSize, getPanelType)
      newRatios[index] = a + clampedDelta
      newRatios[index + 1] = b - clampedDelta

      ratiosRef.current = newRatios
      setSplitRatio(node.id, newRatios)
    },
    [node, isHorizontal, setSplitRatio, getPanelType],
  )

  return (
    <div
      ref={containerRef}
      className={`flex h-full w-full min-h-0 min-w-0 ${isHorizontal ? 'flex-row' : 'flex-col'}`}
    >
      {node.children.map((child, i) => {
        return (
        <React.Fragment key={child.id}>
          <div
            style={{
              [isHorizontal ? 'width' : 'height']: containsMaximized ? '100%' : `calc((100% - ${SPLIT_DIVIDER_SIZE * (node.children.length - 1)}px) * ${node.ratios[i]})`,
              display: containsMaximized && !findTabStack(child, maximizedStackId!) ? 'none' : undefined,
            }}
            className="min-h-0 min-w-0 shrink-0 overflow-hidden"
          >
            {renderNode(child)}
          </div>
          {!containsMaximized && i < node.children.length - 1 && (
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
