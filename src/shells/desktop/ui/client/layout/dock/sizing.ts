// Minimum sizes of dock trees, from the panels' definitions.

import type { DockNode } from '@workspace/document/contract'
import type { Size } from '@workspace/canvas/contract'
import { MIN_PANE_SIZE, panelMinimumSize } from '@client/host'

export const SPLIT_DIVIDER_SIZE = 1
export { MIN_PANE_SIZE }

export type PanelTypeOf = (panelId: string) => string | undefined

export function layoutMinimum(node: DockNode, typeOf?: PanelTypeOf): Size {
  if (node.kind === 'stack') {
    return node.panels.reduce((minimum, id) => {
      const type = typeOf?.(id)
      const panel = type ? panelMinimumSize(type) : MIN_PANE_SIZE
      return { width: Math.max(minimum.width, panel.width), height: Math.max(minimum.height, panel.height) }
    }, MIN_PANE_SIZE)
  }
  const children = node.children.map((child) => layoutMinimum(child, typeOf))
  const horizontal = node.direction === 'horizontal'
  const axis = horizontal ? 'width' : 'height'
  const cross = horizontal ? 'height' : 'width'
  return {
    [axis]: children.reduce((total, size) => total + size[axis], 0) + SPLIT_DIVIDER_SIZE * (children.length - 1),
    [cross]: Math.max(...children.map((size) => size[cross])),
  } as unknown as Size
}

/** Whether the whole dock still fits after `stackId` gains an equal column. */
export function canSplitLayout(layout: DockNode, stackId: string, width: number, height: number, typeOf?: PanelTypeOf): boolean {
  let found = false
  const insert = (node: DockNode): DockNode => {
    if (node.kind === 'stack') {
      if (node.id !== stackId) return node
      found = true
      return {
        kind: 'split', id: '__prospective_split', direction: 'horizontal', ratios: [0.5, 0.5],
        children: [node, { kind: 'stack', id: '__prospective_pane', panels: [] }],
      }
    }
    return { ...node, children: node.children.map(insert) }
  }
  const minimum = layoutMinimum(insert(layout), typeOf)
  return found && width >= minimum.width && height >= minimum.height
}

export function canSplitPane(width: number, height: number, minimum: Size = MIN_PANE_SIZE): boolean {
  return width >= 2 * Math.max(minimum.width, MIN_PANE_SIZE.width) + SPLIT_DIVIDER_SIZE
    && height >= Math.max(minimum.height, MIN_PANE_SIZE.height)
}

/** Clamps a divider move so both neighbours keep their minimums. */
export function clampSplitDelta(
  node: Extract<DockNode, { kind: 'split' }>,
  index: number,
  ratioDelta: number,
  containerSize: number,
  typeOf?: PanelTypeOf,
): number {
  const dimension = node.direction === 'horizontal' ? 'width' : 'height'
  const available = containerSize - SPLIT_DIVIDER_SIZE * (node.children.length - 1)
  const a = node.ratios[index]
  const b = node.ratios[index + 1]
  const minA = layoutMinimum(node.children[index], typeOf)[dimension] / available
  const minB = layoutMinimum(node.children[index + 1], typeOf)[dimension] / available
  if (minA + minB > a + b) return 0
  return Math.max(minA - a, Math.min(b - minB, ratioDelta))
}
