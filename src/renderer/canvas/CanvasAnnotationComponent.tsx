// =============================================================================
// CanvasAnnotationComponent — renders sticky notes and text labels on the canvas.
// =============================================================================

import React, { useCallback, useRef, useState, useEffect } from 'react'
import type { CanvasAnnotation } from '../../shared/types'
import { useCanvasStoreApi } from '../stores/CanvasStoreContext'

interface Props {
  annotation: CanvasAnnotation
}

const CanvasAnnotationComponent: React.FC<Props> = ({ annotation }) => {
  const canvasApi = useCanvasStoreApi()
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState(annotation.content)
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null)
  const dragAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => { dragAbortRef.current?.abort() }
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 2) { e.stopPropagation(); return }
    if (e.button !== 0 || isEditing) return
    e.stopPropagation()
    dragRef.current = {
      startX: e.clientX, startY: e.clientY,
      originX: annotation.origin.x, originY: annotation.origin.y,
    }
    const handleMove = (ev: MouseEvent) => {
      if (!dragRef.current) return
      const zoom = canvasApi.getState().zoomLevel
      const dx = (ev.clientX - dragRef.current.startX) / zoom
      const dy = (ev.clientY - dragRef.current.startY) / zoom
      canvasApi.getState().moveAnnotation(annotation.id, {
        x: dragRef.current.originX + dx,
        y: dragRef.current.originY + dy,
      })
    }
    const handleUp = () => {
      dragAbortRef.current?.abort()
      dragAbortRef.current = null
      dragRef.current = null
    }
    dragAbortRef.current?.abort()
    const controller = new AbortController()
    dragAbortRef.current = controller
    const { signal } = controller
    window.addEventListener('mousemove', handleMove, { signal })
    window.addEventListener('mouseup', handleUp, { signal })
  }, [annotation.id, annotation.origin, isEditing])

  const handleDoubleClick = useCallback(() => {
    setIsEditing(true)
    setEditContent(annotation.content)
  }, [annotation.content])

  const handleBlur = useCallback(() => {
    setIsEditing(false)
    canvasApi.getState().updateAnnotation(annotation.id, editContent)
  }, [annotation.id, editContent])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (confirm('Delete this annotation?')) {
      canvasApi.getState().removeAnnotation(annotation.id)
    }
  }, [annotation.id])

  const isStickyNote = annotation.type === 'stickyNote'

  return (
    <div
      style={{
        position: 'absolute',
        left: annotation.origin.x,
        top: annotation.origin.y,
        width: annotation.size.width,
        height: isStickyNote ? annotation.size.height : 'auto',
        backgroundColor: annotation.color,
        borderRadius: isStickyNote ? 4 : 0,
        padding: isStickyNote ? 12 : 4,
        cursor: isEditing ? 'text' : 'grab',
        zIndex: -500, // Between regions (-1000) and panels (0+)
        boxShadow: isStickyNote ? '0 2px 8px rgba(0,0,0,0.3)' : 'none',
        userSelect: isEditing ? 'text' : 'none',
      }}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
    >
      {isEditing ? (
        <textarea
          autoFocus
          value={editContent}
          onChange={(e) => setEditContent(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={(e) => { if (e.key === 'Escape') handleBlur() }}
          style={{
            width: '100%',
            height: '100%',
            background: 'transparent',
            border: 'none',
            outline: 'none',
            resize: 'none',
            color: isStickyNote ? '#1a1a1a' : 'rgba(255,255,255,0.6)',
            fontSize: isStickyNote ? 13 : 14,
            fontWeight: isStickyNote ? 400 : 600,
            fontFamily: 'inherit',
          }}
        />
      ) : (
        <div style={{
          color: isStickyNote ? '#1a1a1a' : 'rgba(255,255,255,0.6)',
          fontSize: isStickyNote ? 13 : 14,
          fontWeight: isStickyNote ? 400 : 600,
          whiteSpace: isStickyNote ? 'pre-wrap' : 'nowrap',
          overflow: 'hidden',
        }}>
          {annotation.content}
        </div>
      )}
    </div>
  )
}

export default React.memo(CanvasAnnotationComponent)
