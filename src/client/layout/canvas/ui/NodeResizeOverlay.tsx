// Resize hotspots just outside the panel border, in the canvas gutter. They
// are a sibling of the node (not inside its overflow:hidden box) so they can
// overhang, and so the interior, including a scrollbar at the inner edge, is
// never a resize target.

import React from 'react'
import type { ResizeEdge } from '../parts/resizeEdge'

interface NodeResizeOverlayProps {
  onResizeStart: (e: React.MouseEvent, edge: ResizeEdge) => void
  /** Thickness of the band that overhangs the border. */
  band?: number
  /** Corner square size; exact corners are hard to hit. */
  corner?: number
}

const baseStyle: React.CSSProperties = {
  position: 'absolute',
  background: 'transparent',
  pointerEvents: 'auto',
  userSelect: 'none',
}

export function NodeResizeOverlay({ onResizeStart, band = 8, corner = 16 }: NodeResizeOverlayProps): React.ReactElement {
  const mk = (edge: ResizeEdge, style: React.CSSProperties, cursor: string) => (
    <div
      key={edge}
      data-resize-overlay={edge}
      style={{ ...baseStyle, ...style, cursor }}
      onMouseDown={(e) => {
        if (e.button !== 0) return
        onResizeStart(e, edge)
      }}
    />
  )
  // The top band sits outside the top border too, so it never overlaps the
  // tab bar that doubles as the drag handle.
  return (
    <>
      {mk('top', { left: corner, right: corner, top: -band, height: band }, 'ns-resize')}
      {mk('bottom', { left: corner, right: corner, bottom: -band, height: band }, 'ns-resize')}
      {mk('left', { top: corner, bottom: corner, left: -band, width: band }, 'ew-resize')}
      {mk('right', { top: corner, bottom: corner, right: -band, width: band }, 'ew-resize')}
      {mk('topLeft', { top: -band, left: -band, width: corner + band, height: corner + band }, 'nwse-resize')}
      {mk('topRight', { top: -band, right: -band, width: corner + band, height: corner + band }, 'nesw-resize')}
      {mk('bottomLeft', { bottom: -band, left: -band, width: corner + band, height: corner + band }, 'nesw-resize')}
      {mk('bottomRight', { bottom: -band, right: -band, width: corner + band, height: corner + band }, 'nwse-resize')}
    </>
  )
}
