// =============================================================================
// useNodeResizeCursor — node-body mousedown guard for CanvasNode.
//
// Resize is initiated entirely by the NodeResizeOverlay band that sits just
// OUTSIDE the panel border, so the panel interior is never a resize target and
// there is no edge-hover cursor to manage here anymore. This hook only keeps
// right-button mousedown from bubbling to the canvas (which would otherwise
// start a canvas right-drag pan when the user right-clicks inside a panel).
// =============================================================================

import React, { useCallback } from 'react'

export function useNodeResizeCursor() {
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 2) e.stopPropagation()
  }, [])

  return { handleMouseDown }
}
