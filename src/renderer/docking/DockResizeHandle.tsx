// =============================================================================
// DockResizeHandle — drag handle between dock zones or between split children.
// =============================================================================

import React, { useCallback, useRef, useEffect } from 'react'

interface DockResizeHandleProps {
  direction: 'horizontal' | 'vertical' // horizontal = left/right drag, vertical = up/down drag
  onResize: (delta: number) => void
  onDoubleClick?: () => void
}

export default function DockResizeHandle({ direction, onResize, onDoubleClick }: DockResizeHandleProps) {
  const dragging = useRef(false)
  const lastPos = useRef(0)
  const dragAbortRef = useRef<AbortController | null>(null)
  const cursorStyleRef = useRef<HTMLStyleElement | null>(null)

  // If the handle unmounts mid-drag (e.g. the split collapses), tear down the
  // gesture state we'd otherwise leak onto <body>/<head>.
  useEffect(() => {
    return () => {
      dragAbortRef.current?.abort()
      cursorStyleRef.current?.remove()
      cursorStyleRef.current = null
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
      document.body.classList.add('canvas-interacting')
      const cursorStyleEl = document.createElement('style')
      cursorStyleEl.textContent = `*, *::before, *::after { cursor: ${resizeCursor} !important; }`
      document.head.appendChild(cursorStyleEl)
      cursorStyleRef.current = cursorStyleEl

      const onMouseMove = (ev: MouseEvent) => {
        if (!dragging.current) return
        const current = direction === 'horizontal' ? ev.clientX : ev.clientY
        const delta = current - lastPos.current
        if (delta !== 0) {
          onResize(delta)
          lastPos.current = current
        }
      }

      const onMouseUp = () => {
        dragging.current = false
        dragAbortRef.current?.abort()
        dragAbortRef.current = null
        document.body.classList.remove('canvas-interacting')
        cursorStyleEl.remove()
        cursorStyleRef.current = null
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }

      dragAbortRef.current?.abort()
      const controller = new AbortController()
      dragAbortRef.current = controller
      const { signal } = controller
      document.addEventListener('mousemove', onMouseMove, { signal })
      document.addEventListener('mouseup', onMouseUp, { signal })
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
