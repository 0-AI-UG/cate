// =============================================================================
// DockSplitContainer — flex container with children at specified ratios.
// Renders split layout nodes recursively.
// =============================================================================

import React, { useCallback, useRef } from 'react'
import { useDockStoreContext } from '../stores/DockStoreContext'
import { PANEL_MINIMUM_SIZES, type DockLayoutNode, type DockSplitNode, type PanelType } from '../../shared/types'
import { findTabStack } from '../stores/dockTreeUtils'
import DockResizeHandle from './DockResizeHandle'

interface DockSplitContainerProps {
  node: DockSplitNode
  renderNode: (node: DockLayoutNode) => React.ReactNode
  getPanelType?: (panelId: string) => PanelType | undefined
}

function containsCanvas(node: DockLayoutNode, getPanelType?: (panelId: string) => PanelType | undefined): boolean {
  if (!getPanelType) return false
  if (node.type === 'tabs') return node.panelIds.some((panelId) => getPanelType(panelId) === 'canvas')
  return node.children.some((child) => containsCanvas(child, getPanelType))
}

export function clampSplitDelta(
  node: DockSplitNode,
  index: number,
  ratioDelta: number,
  containerSize: number,
  getPanelType?: (panelId: string) => PanelType | undefined,
): number {
  const dimension = node.direction === 'horizontal' ? 'width' : 'height'
  const canvasMinRatio = PANEL_MINIMUM_SIZES.canvas[dimension] / containerSize
  const minimumRatio = (child: DockLayoutNode) => containsCanvas(child, getPanelType) ? canvasMinRatio : 0.1
  const a = node.ratios[index]
  const b = node.ratios[index + 1]
  const requestedMinA = minimumRatio(node.children[index])
  const requestedMinB = minimumRatio(node.children[index + 1])
  // A small window or a multi-way split may not have enough room for both
  // requested pixel minimums. Keep the divider usable in that state instead of
  // freezing it, falling back to the original proportional pane floor.
  const minimumsFit = requestedMinA + requestedMinB <= a + b
  const minA = minimumsFit ? requestedMinA : 0.1
  const minB = minimumsFit ? requestedMinB : 0.1
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
      const ratioDelta = delta / containerSize
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
              [isHorizontal ? 'width' : 'height']: containsMaximized ? '100%' : `${node.ratios[i] * 100}%`,
              display: containsMaximized && !findTabStack(child, maximizedStackId!) ? 'none' : undefined,
            }}
            className="min-h-0 min-w-0 overflow-hidden"
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
