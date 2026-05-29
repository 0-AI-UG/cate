// Invisible resize hotspots that sit just OUTSIDE the panel border, in the
// canvas gutter around the node. Mounted as a sibling of the node (not inside
// its overflow:hidden box) so the strips can overhang the edge. Keeping them
// outside the panel means the interior — including a content scrollbar that
// sits at the very inner edge (e.g. xterm's viewport scrollbar) — is never a
// resize target, so the scrollbar stays fully grabbable (#159).

import React from 'react'
import type { ResizeEdge } from '../hooks/useNodeResize'

interface NodeResizeOverlayProps {
  onResizeStart: (e: React.MouseEvent, edge: ResizeEdge) => void
  /** Thickness of the grab band that overhangs the panel border. */
  band?: number
  /** Corner square size (larger — hitting an exact corner is hard). */
  corner?: number
}

const baseStyle: React.CSSProperties = {
  position: 'absolute',
  background: 'transparent',
  pointerEvents: 'auto',
  userSelect: 'none',
}

export const NodeResizeOverlay: React.FC<NodeResizeOverlayProps> = ({
  onResizeStart,
  band = 8,
  corner = 16,
}) => {
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

  // Negative offsets push every strip just beyond the border. Corners overhang
  // both ways so the diagonal handle is easy to hit. The top band sits OUTSIDE
  // the top border too, so it never overlaps the in-panel title bar / drag
  // handle (which lives just inside the top edge).
  return (
    <>
      {mk('top',    { left: corner, right: corner, top: -band, height: band }, 'ns-resize')}
      {mk('bottom', { left: corner, right: corner, bottom: -band, height: band }, 'ns-resize')}
      {mk('left',   { top: corner, bottom: corner, left: -band, width: band }, 'ew-resize')}
      {mk('right',  { top: corner, bottom: corner, right: -band, width: band }, 'ew-resize')}
      {mk('topLeft',     { top: -band, left: -band, width: corner + band, height: corner + band }, 'nwse-resize')}
      {mk('topRight',    { top: -band, right: -band, width: corner + band, height: corner + band }, 'nesw-resize')}
      {mk('bottomLeft',  { bottom: -band, left: -band, width: corner + band, height: corner + band }, 'nesw-resize')}
      {mk('bottomRight', { bottom: -band, right: -band, width: corner + band, height: corner + band }, 'nwse-resize')}
    </>
  )
}
