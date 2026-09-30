export type ResizeEdge =
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'topLeft'
  | 'topRight'
  | 'bottomLeft'
  | 'bottomRight'

export function getCursorForEdge(edge: ResizeEdge | null): string {
  switch (edge) {
    case 'top':
    case 'bottom':
      return 'ns-resize'
    case 'left':
    case 'right':
      return 'ew-resize'
    case 'topLeft':
    case 'bottomRight':
      return 'nwse-resize'
    case 'topRight':
    case 'bottomLeft':
      return 'nesw-resize'
    default:
      return 'default'
  }
}

export interface EdgeFlags {
  left: boolean
  right: boolean
  top: boolean
  bottom: boolean
}

export function edgeFlags(edge: ResizeEdge): EdgeFlags {
  return {
    left: edge === 'left' || edge === 'topLeft' || edge === 'bottomLeft',
    right: edge === 'right' || edge === 'topRight' || edge === 'bottomRight',
    top: edge === 'top' || edge === 'topLeft' || edge === 'topRight',
    bottom: edge === 'bottom' || edge === 'bottomLeft' || edge === 'bottomRight',
  }
}

export function isCardinalEdge(edge: ResizeEdge): edge is 'top' | 'bottom' | 'left' | 'right' {
  return edge === 'top' || edge === 'bottom' || edge === 'left' || edge === 'right'
}
