import { PANEL_MINIMUM_SIZES, type DockLayoutNode, type PanelType } from '../../shared/types'

export const SPLIT_DIVIDER_SIZE = 5
export const MIN_PANE_SIZE = { width: 320, height: 220 }

export function layoutMinimum(node: DockLayoutNode, getPanelType?: (id: string) => PanelType | undefined): { width: number; height: number } {
  if (node.type === 'tabs') {
    return node.panelIds.reduce((minimum, id) => {
      const type = getPanelType?.(id)
      const panelMinimum = type ? PANEL_MINIMUM_SIZES[type] : MIN_PANE_SIZE
      return {
        width: Math.max(minimum.width, panelMinimum.width),
        height: Math.max(minimum.height, panelMinimum.height),
      }
    }, MIN_PANE_SIZE)
  }
  const children = node.children.map((child) => layoutMinimum(child, getPanelType))
  const horizontal = node.direction === 'horizontal'
  const axis = horizontal ? 'width' : 'height'
  const cross = horizontal ? 'height' : 'width'
  return {
    [axis]: children.reduce((total, size) => total + size[axis], 0) + SPLIT_DIVIDER_SIZE * (children.length - 1),
    [cross]: Math.max(...children.map((size) => size[cross])),
  } as { width: number; height: number }
}

/** Check the whole dock: a new column can share space with existing siblings. */
export function canSplitLayout(layout: DockLayoutNode, stackId: string, width: number, height: number, getPanelType?: (id: string) => PanelType | undefined): boolean {
  let found = false
  const insert = (node: DockLayoutNode): DockLayoutNode => {
    if (node.type === 'tabs') {
      if (node.id !== stackId) return node
      found = true
      return { type: 'split', id: '__prospective_split', direction: 'horizontal', ratios: [0.5, 0.5], children: [node, { type: 'tabs', id: '__prospective_pane', panelIds: [], activeIndex: 0 }] }
    }
    return { ...node, children: node.children.map(insert) }
  }
  const minimum = layoutMinimum(insert(layout), getPanelType)
  return found && width >= minimum.width && height >= minimum.height
}

export function canSplitPane(width: number, height: number, minimum = MIN_PANE_SIZE): boolean {
  return width >= 2 * Math.max(minimum.width, MIN_PANE_SIZE.width) + SPLIT_DIVIDER_SIZE
    && height >= Math.max(minimum.height, MIN_PANE_SIZE.height)
}
