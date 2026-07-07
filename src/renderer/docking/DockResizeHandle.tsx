// =============================================================================
// DockResizeHandle — drag handle between dock zones or between split children.
// =============================================================================

import React, { useCallback, useRef, useEffect } from 'react'
import { pinDocumentCursor } from '../lib/dom/pinDocumentCursor'

interface DockResizeHandleProps {
  direction: 'horizontal' | 'vertical' // horizontal = left/right drag, vertical = up/down drag
  onResize: (delta: number) => void
  onDoubleClick?: () => void
}

export default function DockResizeHandle({ direction, onResize, onDoubleClick }: DockResizeHandleProps) {
  const dragging = useRef(false)
  const lastPos = useRef(0)
  const dragAbortRef = useRef<AbortController | null>(null)
  const unpinCursorRef = useRef<(() => void) | null>(null)

  // If the handle unmounts mid-drag (e.g. the split collapses), tear down the
  // gesture state we'd otherwise leak onto <body>/<head>.
  useEffect(() => {
    return () => {
      dragAbortRef.current?.abort()
      unpinCursorRef.current?.()
      unpinCursorRef.current = null
      if (dragging.current) {
        dragging.current = false
        document.body.classList.remove('canvas-interacting')
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }
  }, [])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      dragging.current = true
      lastPos.current = direction === 'horizontal' ? e.clientX : e.clientY
      const resizeCursor = direction === 'horizontal' ? 'col-resize' : 'row-resize'

      // Hold `canvas-interacting` for the whole drag, exactly as useNodeResize
      // does for a panel-edge resize. A split child can be a terminal, and the
      // TerminalPanel guards on this class to (a) defer xterm fit() so the
      // WebGL canvas doesn't re-size every tick and flash the divider wider,
      // and (b) skip adjustCoords so this handler's clientX isn't rewritten in
      // the capture phase — otherwise the divider reads a moving target and
      // runs away from the cursor on a zoomed canvas. The class also force-pins
      // xterm to `grabbing`, so inject a high-specificity cursor override (same
      // trick as useNodeResize) to keep the resize cursor. Cleaned up on mouseup.
      const unpinCursor = pinDocumentCursor(resizeCursor)
      unpinCursorRef.current = unpinCursor

      const onMouseMove = (ev: MouseEvent) => {
        if (!dragging.current) return
        const current = direction === 'horizontal' ? ev.clientX : ev.clientY
        const delta = current - lastPos.current
        if (delta !== 0) {
          onResize(delta)
          lastPos.current = current
        }
      }

      // Shared teardown for the normal mouseup path and the blur-cancel path.
      // A window blur with no matching mouseup happens on Cmd+Tab or a macOS
      // Spaces swipe away mid-drag; without this the `pinDocumentCursor`
      // `!important` override leaks onto the whole document and the OS cursor
      // stays stuck until the next click. Mirrors useNodeResize's detach().
      const endDrag = () => {
        dragging.current = false
        dragAbortRef.current?.abort()
        dragAbortRef.current = null
        unpinCursor()
        unpinCursorRef.current = null
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }

      dragAbortRef.current?.abort()
      const controller = new AbortController()
      dragAbortRef.current = controller
      const { signal } = controller
      document.addEventListener('mousemove', onMouseMove, { signal })
      document.addEventListener('mouseup', endDrag, { signal })
      window.addEventListener('blur', endDrag, { signal })
      document.body.style.cursor = resizeCursor
      document.body.style.userSelect = 'none'
    },
    [direction, onResize],
  )

  const isHorizontal = direction === 'horizontal'

  return (
    <div
      className={`
        flex-shrink-0 relative group
        ${isHorizontal ? 'w-[5px] cursor-col-resize' : 'h-[5px] cursor-row-resize'}
      `}
      onMouseDown={handleMouseDown}
      onDoubleClick={onDoubleClick}
    >
      {/* Visible indicator on hover */}
      <div
        className={`
          absolute bg-surface-6 group-hover:bg-surface-6 transition-colors duration-150
          ${isHorizontal ? 'inset-y-0 left-[2px] right-[2px]' : 'inset-x-0 top-[2px] bottom-[2px]'}
        `}
      />
    </div>
  )
}
