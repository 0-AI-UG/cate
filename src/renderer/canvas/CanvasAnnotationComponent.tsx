// =============================================================================
// CanvasAnnotationComponent — renders sticky notes and text labels on the canvas.
// =============================================================================

import React, { useCallback, useRef, useState } from 'react'
import { X } from '@phosphor-icons/react'
import type { CanvasAnnotation } from '../../shared/types'
import { useCanvasStoreApi } from '../stores/CanvasStoreContext'
import { consumePendingAnnotationEdit } from '../stores/canvasStore'
import type { NativeContextMenuItem } from '../../shared/electron-api'

// Preset colors for sticky notes — 6-color muted pastel palette at alpha 0.92
const STICKY_COLORS = [
  { label: 'Yellow', value: 'rgba(255, 221, 87, 0.92)' },
  { label: 'Green', value: 'rgba(134, 219, 143, 0.92)' },
  { label: 'Blue', value: 'rgba(138, 180, 248, 0.92)' },
  { label: 'Pink', value: 'rgba(244, 143, 177, 0.92)' },
  { label: 'Purple', value: 'rgba(197, 167, 233, 0.92)' },
  { label: 'Gray', value: 'rgba(220, 222, 227, 0.92)' },
]

// Preset colors for text labels — same hues at 0.85 + transparent default
const LABEL_COLORS = [
  { label: 'Default', value: 'transparent' },
  { label: 'Yellow', value: 'rgba(255, 221, 87, 0.85)' },
  { label: 'Green', value: 'rgba(134, 219, 143, 0.85)' },
  { label: 'Blue', value: 'rgba(138, 180, 248, 0.85)' },
  { label: 'Pink', value: 'rgba(244, 143, 177, 0.85)' },
  { label: 'Purple', value: 'rgba(197, 167, 233, 0.85)' },
  { label: 'Gray', value: 'rgba(220, 222, 227, 0.85)' },
]

const FONT_SIZE_MAP: Record<'sm' | 'md' | 'lg' | 'xl', number> = { sm: 12, md: 14, lg: 18, xl: 28 }
const LABEL_FONT_SIZE_MAP: Record<'sm' | 'md' | 'lg' | 'xl', number> = { sm: 12, md: 16, lg: 22, xl: 36 }

interface Props {
  annotation: CanvasAnnotation
}

const CanvasAnnotationComponent: React.FC<Props> = ({ annotation }) => {
  const canvasApi = useCanvasStoreApi()
  // Start in edit mode if this annotation was just created (pending set).
  const [isEditing, setIsEditing] = useState(() => consumePendingAnnotationEdit(annotation.id))
  const [editContent, setEditContent] = useState(annotation.content)
  const [hovered, setHovered] = useState(false)
  const [resizeHovered, setResizeHovered] = useState(false)
  const measureRef = useRef<HTMLSpanElement | null>(null)
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null)
  const dragAbortRef = useRef<AbortController | null>(null)

  React.useEffect(() => {
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

  const isStickyNote = annotation.type === 'stickyNote'

  const handleBlur = useCallback(() => {
    setIsEditing(false)
    const trimmed = editContent.trim()
    // An empty text label left empty on blur deletes itself — prevents
    // dangling placeholder labels when users change their mind.
    if (!isStickyNote && trimmed.length === 0) {
      canvasApi.getState().removeAnnotation(annotation.id)
      return
    }
    canvasApi.getState().updateAnnotation(annotation.id, editContent)
  }, [annotation.id, editContent, isStickyNote, canvasApi])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      // Escape reverts any in-progress edit; an empty new label is removed.
      if (!isStickyNote && annotation.content.trim().length === 0) {
        setIsEditing(false)
        canvasApi.getState().removeAnnotation(annotation.id)
        return
      }
      setEditContent(annotation.content)
      setIsEditing(false)
      return
    }
    // For single-line text labels, Enter commits. Shift+Enter inserts a
    // newline (users who really want multi-line labels can still get them).
    if (e.key === 'Enter' && !e.shiftKey && !isStickyNote) {
      e.preventDefault()
      ;(e.currentTarget as HTMLTextAreaElement).blur()
    }
  }, [annotation.id, annotation.content, isStickyNote, canvasApi])
  const currentFontSize = FONT_SIZE_MAP[annotation.fontSize ?? 'md']
  const textColor = isStickyNote
    ? 'var(--text-inverse)'
    : annotation.color === 'transparent'
      ? 'var(--text-primary)'
      : 'var(--text-inverse)'

  const handleContextMenu = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!window.electronAPI) return
    const colors = isStickyNote ? STICKY_COLORS : LABEL_COLORS
    const colorSubmenu: NativeContextMenuItem[] = colors.map((c, i) => ({
      id: `color:${i}`,
      label: annotation.color === c.value ? `${c.label} ✓` : c.label,
    }))
    const currentFs = annotation.fontSize ?? 'md'
    const sizeSubmenu: NativeContextMenuItem[] = [
      { id: 'size:sm', label: currentFs === 'sm' ? 'Small ✓' : 'Small' },
      { id: 'size:md', label: currentFs === 'md' ? 'Medium ✓' : 'Medium' },
      { id: 'size:lg', label: currentFs === 'lg' ? 'Large ✓' : 'Large' },
      { id: 'size:xl', label: currentFs === 'xl' ? 'Extra Large ✓' : 'Extra Large' },
    ]
    const id = await window.electronAPI.showContextMenu([
      { id: 'edit', label: 'Edit' },
      { id: 'clear', label: 'Clear Text' },
      { label: 'Change Color', submenu: colorSubmenu },
      { label: 'Text Size', submenu: sizeSubmenu },
      { id: 'bold', label: annotation.bold ? 'Bold ✓' : 'Bold' },
      { type: 'separator' as const },
      { id: 'delete', label: isStickyNote ? 'Delete Note' : 'Delete Label' },
    ])
    if (!id) return
    if (id === 'edit') {
      setIsEditing(true)
      setEditContent(annotation.content)
      return
    }
    if (id === 'clear') {
      canvasApi.getState().updateAnnotation(annotation.id, '')
      setEditContent('')
      return
    }
    if (id.startsWith('color:')) {
      const idx = parseInt(id.slice(6), 10)
      const c = (isStickyNote ? STICKY_COLORS : LABEL_COLORS)[idx]
      canvasApi.getState().updateAnnotationColor(annotation.id, c.value)
      return
    }
    if (id.startsWith('size:')) {
      const sz = id.slice(5) as 'sm' | 'md' | 'lg' | 'xl'
      canvasApi.getState().setAnnotationFontSize(annotation.id, sz)
      return
    }
    if (id === 'bold') {
      canvasApi.getState().setAnnotationBold(annotation.id, !annotation.bold)
      return
    }
    if (id === 'delete') canvasApi.getState().removeAnnotation(annotation.id)
  }, [annotation.id, annotation.content, annotation.color, annotation.fontSize, annotation.bold, isStickyNote, canvasApi])

  // Resize handle (sticky notes only) — bottom-right corner drag
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const startW = annotation.size.width
    const startH = annotation.size.height
    const handleMove = (ev: MouseEvent) => {
      const zoom = canvasApi.getState().zoomLevel
      const dw = (ev.clientX - startX) / zoom
      const dh = (ev.clientY - startY) / zoom
      canvasApi.getState().resizeAnnotation(annotation.id, {
        width: startW + dw,
        height: startH + dh,
      })
    }
    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
  }, [annotation.id, annotation.size.width, annotation.size.height, canvasApi])

  const handleClose = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    canvasApi.getState().removeAnnotation(annotation.id)
  }, [annotation.id, canvasApi])

  const baseShadow = isStickyNote
    ? '0 1px 2px var(--shadow-node), 0 4px 12px var(--shadow-node)'
    : 'none'
  const hoverRing = '0 0 0 1.5px rgba(74,158,255,0.5)'
  const showRing = hovered || isEditing
  const boxShadow = isStickyNote
    ? showRing ? baseShadow + ', ' + hoverRing : baseShadow
    : showRing ? hoverRing : 'none'

  const labelFontSize = annotation.fontSizePx ?? LABEL_FONT_SIZE_MAP[annotation.fontSize ?? 'md']
  const labelFontWeight = (annotation.bold ?? true) ? 700 : 400

  // Drag-to-scale handle for text labels — Figma-style corner scaling.
  const handleLabelScaleMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const startSize = labelFontSize
    const handleMove = (ev: MouseEvent) => {
      const zoom = canvasApi.getState().zoomLevel
      // Use diagonal distance so dragging down-right grows, up-left shrinks.
      const dx = (ev.clientX - startX) / zoom
      const dy = (ev.clientY - startY) / zoom
      const delta = (dx + dy) / 2
      canvasApi.getState().setAnnotationFontSizePx(annotation.id, startSize + delta)
    }
    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
  }, [annotation.id, labelFontSize, canvasApi])

  return (
    <>
      <div
        style={{
          position: 'absolute',
          left: annotation.origin.x,
          top: annotation.origin.y,
          width: isStickyNote ? annotation.size.width : 'auto',
          minWidth: isStickyNote ? undefined : 40,
          maxWidth: isStickyNote ? undefined : 600,
          height: isStickyNote ? annotation.size.height : 'auto',
          backgroundColor: annotation.color,
          borderRadius: isStickyNote ? 8 : 4,
          border: isStickyNote ? `1px solid var(--border-subtle)` : 'none',
          padding: isStickyNote ? '14px 16px' : '4px 6px',
          cursor: isEditing ? 'text' : 'grab',
          zIndex: -500, // Between regions (-1000) and panels (0+)
          boxShadow,
          userSelect: isEditing ? 'text' : 'none',
        }}
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {isStickyNote && hovered && !isEditing && (
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={handleClose}
            title="Delete note"
            style={{
              position: 'absolute',
              top: 4,
              right: 4,
              width: 20,
              height: 20,
              borderRadius: 10,
              background: 'var(--shadow-node)',
              color: 'var(--text-primary)',
              border: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              padding: 0,
              zIndex: 2,
            }}
          >
            <X size={14} />
          </button>
        )}
        {isEditing ? (
          isStickyNote ? (
            <textarea
              autoFocus
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              style={{
                width: '100%',
                height: '100%',
                background: 'transparent',
                border: 'none',
                outline: 'none',
                resize: 'none',
                color: textColor,
                fontSize: currentFontSize,
                fontWeight: 500,
                fontFamily: 'inherit',
                lineHeight: 1.45,
              }}
            />
          ) : (
            // Auto-sizing text label editor: an inline-grid with a hidden
            // measuring span sized to the content, and a textarea stacked on
            // top that fills the same grid cell. The wrapper grows with the
            // text so the label stays just big enough.
            <div
              style={{
                display: 'inline-grid',
                minWidth: 30,
              }}
            >
              <span
                ref={measureRef}
                aria-hidden
                style={{
                  gridArea: '1 / 1',
                  visibility: 'hidden',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontSize: labelFontSize,
                  fontWeight: labelFontWeight,
                  fontFamily: 'inherit',
                  lineHeight: 1.45,
                  padding: '0 1px',
                }}
              >
                {editContent || 'Label'}
                {/* trailing space ensures wrapper grows by one char when the
                    user presses space at end of text */}
                {'\u200b'}
              </span>
              <textarea
                autoFocus
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                onBlur={handleBlur}
                onKeyDown={handleKeyDown}
                rows={1}
                style={{
                  gridArea: '1 / 1',
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  resize: 'none',
                  color: textColor,
                  fontSize: labelFontSize,
                  fontWeight: labelFontWeight,
                  fontFamily: 'inherit',
                  lineHeight: 1.45,
                  padding: '0 1px',
                  overflow: 'hidden',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              />
            </div>
          )
        ) : (
          <>
            {!annotation.content && (
              <div style={{
                color: textColor,
                fontSize: isStickyNote ? currentFontSize : labelFontSize,
                fontWeight: isStickyNote ? (annotation.bold ? 700 : 500) : labelFontWeight,
                lineHeight: 1.45,
                opacity: 0.45,
                pointerEvents: 'none',
                userSelect: 'none',
                whiteSpace: 'nowrap',
              }}>
                {isStickyNote ? 'Note' : 'Label'}
              </div>
            )}
            {annotation.content && (
              <div style={{
                color: textColor,
                fontSize: isStickyNote ? currentFontSize : labelFontSize,
                fontWeight: isStickyNote ? (annotation.bold ? 700 : 500) : labelFontWeight,
                whiteSpace: 'pre-wrap',
                overflow: isStickyNote ? 'auto' : 'visible',
                width: isStickyNote ? '100%' : 'auto',
                height: isStickyNote ? '100%' : 'auto',
                lineHeight: 1.45,
                wordBreak: 'break-word',
              }}>
                {annotation.content}
              </div>
            )}
          </>
        )}
        {!isStickyNote && hovered && !isEditing && (
          <div
            onMouseDown={handleLabelScaleMouseDown}
            title="Drag to scale"
            style={{
              position: 'absolute',
              right: -6,
              bottom: -6,
              width: 12,
              height: 12,
              cursor: 'nwse-resize',
              background: 'var(--focus-blue)',
              border: `1.5px solid var(--surface-6)`,
              borderRadius: 2,
              boxShadow: '0 1px 2px var(--shadow-node)',
              zIndex: 3,
            }}
          />
        )}
        {isStickyNote && (
          <div
            onMouseDown={handleResizeMouseDown}
            onMouseEnter={() => setResizeHovered(true)}
            onMouseLeave={() => setResizeHovered(false)}
            title="Resize"
            style={{
              position: 'absolute',
              right: 0,
              bottom: 0,
              width: 12,
              height: 12,
              cursor: 'nwse-resize',
              borderBottomRightRadius: 8,
            }}
          >
            {resizeHovered && (
              <>
                {/* vertical line of inverted-L handle */}
                <div style={{
                  position: 'absolute',
                  right: 3,
                  bottom: 3,
                  width: 1.5,
                  height: 7,
                  background: 'var(--shadow-node)',
                  borderRadius: 1,
                }} />
                {/* horizontal line of inverted-L handle */}
                <div style={{
                  position: 'absolute',
                  right: 3,
                  bottom: 3,
                  width: 7,
                  height: 1.5,
                  background: 'var(--shadow-node)',
                  borderRadius: 1,
                }} />
              </>
            )}
          </div>
        )}
      </div>
    </>
  )
}

export default React.memo(CanvasAnnotationComponent)
