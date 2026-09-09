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
    [axis]: Math.max(...children.map((size, index) => size[axis] / node.ratios[index])) + SPLIT_DIVIDER_SIZE * (children.length - 1),
    [cross]: Math.max(...children.map((size) => size[cross])),
  } as { width: number; height: number }
}

export function canSplitPane(width: number, height: number, minimum = MIN_PANE_SIZE): boolean {
  return width >= 2 * Math.max(minimum.width, MIN_PANE_SIZE.width) + SPLIT_DIVIDER_SIZE
    && height >= Math.max(minimum.height, MIN_PANE_SIZE.height)
}
