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

  useEffect(() => {
    return () => { dragAbortRef.current?.abort() }
  }, [])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      dragging.current = true
      lastPos.current = direction === 'horizontal' ? e.clientX : e.clientY

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
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }

      dragAbortRef.current?.abort()
      const controller = new AbortController()
      dragAbortRef.current = controller
      const { signal } = controller
      document.addEventListener('mousemove', onMouseMove, { signal })
      document.addEventListener('mouseup', onMouseUp, { signal })
      document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize'
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
          absolute bg-white/[0.10] group-hover:bg-white/[0.20] transition-colors duration-150
          ${isHorizontal ? 'inset-y-0 left-[2px] right-[2px]' : 'inset-x-0 top-[2px] bottom-[2px]'}
        `}
      />
    </div>
  )
}
