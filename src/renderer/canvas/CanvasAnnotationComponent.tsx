// =============================================================================
// CanvasAnnotationComponent — renders sticky notes and text labels on the canvas.
// =============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { X } from '@phosphor-icons/react'
import type { CanvasAnnotation } from '../../shared/types'
import { useCanvasStoreApi } from '../stores/CanvasStoreContext'
import { consumePendingAnnotationEdit } from '../stores/canvasStore'
import type { NativeContextMenuItem } from '../../shared/electron-api'

// =============================================================================
// ImageAnnotation — separate component so its own useState/useEffect hooks
// don't change hook order in CanvasAnnotationComponent (sticky / label render
// paths don't load images).
// =============================================================================

const ImageAnnotation: React.FC<{ annotation: CanvasAnnotation }> = ({ annotation }) => {
  const canvasApi = useCanvasStoreApi()
  const [imageSrc, setImageSrc] = useState<string>('')
  const [hovered, setHovered] = useState(false)
  const [active, setActive] = useState(false)
  const [resizeHovered, setResizeHovered] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null)
  const dragAbortRef = useRef<AbortController | null>(null)

  useEffect(() => () => { dragAbortRef.current?.abort() }, [])

  useEffect(() => {
    if (!active) return
    const onDown = (ev: MouseEvent): void => {
      const el = rootRef.current
      if (el && !el.contains(ev.target as Node)) setActive(false)
    }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [active])

  useEffect(() => {
    let cancelled = false
    if (!annotation.imagePath) { setImageSrc(''); return }
    window.electronAPI.readImageAsDataUrl(annotation.imagePath).then((res) => {
      if (cancelled || !res) return
      setImageSrc(res.dataUrl)
    }).catch(() => { /* leave blank — broken image stays empty */ })
    return () => { cancelled = true }
  }, [annotation.imagePath])

  const handleMouseDown = useCallback((e: React.MouseEvent): void => {
    if (e.button === 2) { e.stopPropagation(); return }
    if (e.button !== 0) return
    e.stopPropagation()
    setActive(true)
    dragRef.current = {
      startX: e.clientX, startY: e.clientY,
      originX: annotation.origin.x, originY: annotation.origin.y,
    }
    const handleMove = (ev: MouseEvent): void => {
      if (!dragRef.current) return
      const zoom = canvasApi.getState().zoomLevel
      canvasApi.getState().moveAnnotation(annotation.id, {
        x: dragRef.current.originX + (ev.clientX - dragRef.current.startX) / zoom,
        y: dragRef.current.originY + (ev.clientY - dragRef.current.startY) / zoom,
      })
    }
    const handleUp = (): void => {
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
  }, [annotation.id, annotation.origin.x, annotation.origin.y, canvasApi])

  const handleClose = useCallback((e: React.MouseEvent): void => {
    e.stopPropagation()
    canvasApi.getState().removeAnnotation(annotation.id)
  }, [annotation.id, canvasApi])

  const handleImageResizeMouseDown = useCallback((e: React.MouseEvent): void => {
    e.stopPropagation()
    e.preventDefault()
    const startX = e.clientX
    const startW = annotation.size.width
    const startH = annotation.size.height
    const ar = startH > 0 ? startW / startH : 1
    const onMove = (ev: MouseEvent): void => {
      const zoom = canvasApi.getState().zoomLevel
      const dw = (ev.clientX - startX) / zoom
      const newW = Math.max(60, startW + dw)
      const newH = Math.max(40, newW / ar)
      canvasApi.getState().resizeAnnotation(annotation.id, { width: newW, height: newH })
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [annotation.id, annotation.size.width, annotation.size.height, canvasApi])

  const handleContextMenu = useCallback((e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    window.electronAPI?.showContextMenu([
      { id: 'delete', label: 'Delete Image' },
    ]).then((id) => {
      if (id === 'delete') canvasApi.getState().removeAnnotation(annotation.id)
    })
  }, [annotation.id, canvasApi])

  const shadow = active
    ? '0 1px 2px var(--shadow-node), 0 6px 18px var(--shadow-node), 0 0 0 2px rgba(74,158,255,0.85)'
    : hovered
      ? '0 1px 2px var(--shadow-node), 0 6px 18px var(--shadow-node), 0 0 0 1.5px rgba(74,158,255,0.5)'
      : '0 1px 2px var(--shadow-node), 0 6px 18px var(--shadow-node)'

  return (
    <div
      ref={rootRef}
      style={{
        position: 'absolute',
        left: annotation.origin.x,
        top: annotation.origin.y,
        width: annotation.size.width,
        height: annotation.size.height,
        borderRadius: 6,
        cursor: 'grab',
        // Images render above panels so a freshly dropped screenshot is always
        // visible — sticky notes / labels stay below at -500 as canvas decor.
        zIndex: 2500,
        boxShadow: shadow,
        overflow: 'hidden',
        background: 'var(--surface-5)',
      }}
      onMouseDown={handleMouseDown}
      onContextMenu={handleContextMenu}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {imageSrc && (
        <img
          src={imageSrc}
          alt=""
          draggable={false}
          onLoad={(e) => {
            const img = e.currentTarget as HTMLImageElement
            const nw = img.naturalWidth
            const nh = img.naturalHeight
            if (!nw || !nh) return
            if (annotation.autoSize === false) return
            const maxW = 480
            const maxH = 360
            let w = nw
            let h = nh
            if (w > maxW) { h = h * (maxW / w); w = maxW }
            if (h > maxH) { w = w * (maxH / h); h = maxH }
            canvasApi.getState().resizeAnnotation(annotation.id, { width: w, height: h })
          }}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'fill',
            display: 'block',
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        />
      )}
      {hovered && (
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={handleClose}
          title="Delete image"
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            width: 22,
            height: 22,
            borderRadius: 11,
            background: 'rgba(0,0,0,0.6)',
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
      <div
        onMouseDown={handleImageResizeMouseDown}
        onMouseEnter={() => setResizeHovered(true)}
        onMouseLeave={() => setResizeHovered(false)}
        style={{
          position: 'absolute',
          right: 0,
          bottom: 0,
          width: 14,
          height: 14,
          cursor: 'nwse-resize',
          background: resizeHovered
            ? 'linear-gradient(135deg, transparent 50%, rgba(74,158,255,0.85) 50%)'
            : 'linear-gradient(135deg, transparent 55%, rgba(255,255,255,0.35) 55%)',
          zIndex: 3,
        }}
      />
    </div>
  )
}

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
  const [active, setActive] = useState(false)
  const [resizeHovered, setResizeHovered] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const measureRef = useRef<HTMLSpanElement | null>(null)
  const labelWrapperRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null)
  const dragAbortRef = useRef<AbortController | null>(null)

  React.useEffect(() => {
    return () => { dragAbortRef.current?.abort() }
  }, [])

  // Clear the active state when the user clicks/mousedowns outside this
  // annotation — same lifecycle as a panel losing focus.
  React.useEffect(() => {
    if (!active) return
    const onDown = (ev: MouseEvent) => {
      const el = rootRef.current
      if (el && !el.contains(ev.target as Node)) setActive(false)
    }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [active])

  const isStickyNoteEarly = annotation.type === 'stickyNote'

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 2) { e.stopPropagation(); return }
    if (e.button !== 0 || isEditing) return
    e.stopPropagation()
    setActive(true)
    // Alt-drag starts a connection from this annotation (sticky-note as a
    // first-class connection endpoint — same behavior as canvas-node tabs).
    if (e.altKey) {
      e.preventDefault()
      const startId = annotation.id
      const overlay = document.createElement('div')
      overlay.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;pointer-events:none;z-index:100000;'
      overlay.innerHTML = `<svg width="100%" height="100%" style="position:absolute;inset:0"><path id="cate-connect-ghost-ann" d="" stroke="#4a9eff" stroke-width="2" stroke-dasharray="6 6" fill="none"/></svg>`
      document.body.appendChild(overlay)
      const ghost = overlay.querySelector<SVGPathElement>('#cate-connect-ghost-ann')!
      const getStart = () => {
        const a = canvasApi.getState().annotations[startId]
        if (!a) return { x: e.clientX, y: e.clientY }
        const cx = a.origin.x + a.size.width / 2
        const cy = a.origin.y + a.size.height / 2
        return canvasApi.getState().canvasToView({ x: cx, y: cy })
      }
      const findTargetAt = (cx: number, cy: number): string | null => {
        const cs = canvasApi.getState().viewToCanvas({ x: cx, y: cy })
        const state = canvasApi.getState()
        for (const n of Object.values(state.nodes)) {
          if (cs.x >= n.origin.x && cs.x <= n.origin.x + n.size.width &&
              cs.y >= n.origin.y && cs.y <= n.origin.y + n.size.height) return n.id
        }
        for (const a of Object.values(state.annotations)) {
          if (a.id === startId) continue
          if (cs.x >= a.origin.x && cs.x <= a.origin.x + a.size.width &&
              cs.y >= a.origin.y && cs.y <= a.origin.y + a.size.height) return a.id
        }
        return null
      }
      let hover: string | null = null
      const onMove = (ev: MouseEvent) => {
        const sp = getStart()
        ghost.setAttribute('d', `M ${sp.x} ${sp.y} L ${ev.clientX} ${ev.clientY}`)
        hover = findTargetAt(ev.clientX, ev.clientY)
        ghost.setAttribute('stroke', hover ? '#4a9eff' : '#7c8aa1')
      }
      const cleanup = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        window.removeEventListener('keydown', onKey)
        overlay.remove()
      }
      const onUp = (ev: MouseEvent) => {
        cleanup()
        const target = hover ?? findTargetAt(ev.clientX, ev.clientY)
        if (target) canvasApi.getState().addConnection(startId, target)
      }
      const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') cleanup() }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      window.addEventListener('keydown', onKey)
      const sp = getStart()
      ghost.setAttribute('d', `M ${sp.x} ${sp.y} L ${e.clientX} ${e.clientY}`)
      return
    }
    dragRef.current = {
      startX: e.clientX, startY: e.clientY,
      originX: annotation.origin.x, originY: annotation.origin.y,
    }
    let moved = false
    const handleMove = (ev: MouseEvent) => {
      if (!dragRef.current) return
      const dxRaw = ev.clientX - dragRef.current.startX
      const dyRaw = ev.clientY - dragRef.current.startY
      if (!moved && dxRaw * dxRaw + dyRaw * dyRaw < 9) return
      moved = true
      const zoom = canvasApi.getState().zoomLevel
      canvasApi.getState().moveAnnotation(annotation.id, {
        x: dragRef.current.originX + dxRaw / zoom,
        y: dragRef.current.originY + dyRaw / zoom,
      })
    }
    const handleUp = () => {
      dragAbortRef.current?.abort()
      dragAbortRef.current = null
      dragRef.current = null
      // Click-without-drag on a text label enters edit mode. Sticky notes
      // keep double-click-to-edit (less accidental rewrites of long notes).
      if (!moved && !isStickyNoteEarly) {
        setIsEditing(true)
        setEditContent(annotation.content)
      }
    }
    dragAbortRef.current?.abort()
    const controller = new AbortController()
    dragAbortRef.current = controller
    const { signal } = controller
    window.addEventListener('mousemove', handleMove, { signal })
    window.addEventListener('mouseup', handleUp, { signal })
  }, [annotation.id, annotation.origin, annotation.content, isEditing, isStickyNoteEarly, canvasApi])

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
    // Cmd/Ctrl+Enter commits a text label edit. Plain Enter inserts a newline
    // — the label is single-line by default and only breaks where the user
    // explicitly asks for it.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !isStickyNote) {
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
      const w = startW + dw
      const h = startH + dh
      canvasApi.getState().resizeAnnotation(annotation.id, { width: w, height: h })
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

  // Image annotations have their own component (different hooks/render path).
  if (annotation.type === 'image') {
    return <ImageAnnotation annotation={annotation} />
  }

  const baseShadow = isStickyNote
    ? '0 1px 2px var(--shadow-node), 0 4px 12px var(--shadow-node)'
    : 'none'
  const hoverRing = '0 0 0 1.5px rgba(74,158,255,0.5)'
  // Active sticky notes get a glow tinted to match the note color — same
  // role as the blue focus glow on canvas nodes, but per-note so the cue
  // stays recognizable across the color palette.
  const glowRgb = (() => {
    const m = annotation.color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
    return m ? `${m[1]},${m[2]},${m[3]}` : '255,221,87'
  })()
  const activeGlow = `0 0 0 2px rgba(${glowRgb},0.85), 0 0 24px 4px rgba(${glowRgb},0.45)`
  const showRing = hovered || isEditing
  const stickyShadow = active
    ? baseShadow + ', ' + activeGlow
    : showRing
      ? baseShadow + ', ' + hoverRing
      : baseShadow
  // Text labels get a dashed outline instead of a solid hover ring — labels
  // are box-less by default, so the dashes signal "this is an editable text
  // object" without making the canvas feel boxed-in. Outline (not border)
  // keeps the box from shifting when the dashes appear/disappear.
  const labelOutline = !isStickyNote && (showRing || active)
    ? '1.5px dashed rgba(74,158,255,0.85)'
    : '1.5px dashed transparent'
  const labelOutlineOffset = !isStickyNote ? 2 : undefined
  const boxShadow = isStickyNote
    ? stickyShadow
    : 'none'

  const labelFontSize = annotation.fontSizePx ?? LABEL_FONT_SIZE_MAP[annotation.fontSize ?? 'md']
  const labelFontWeight = (annotation.bold ?? true) ? 700 : 400

  // Corner-resize handle for text labels — resizes the box; the font is
  // adjusted via the context-menu "Text Size" submenu (decoupled by design).
  // Labels are auto-sized until first resize; on drag start we seed startW/H
  // from the currently rendered DOM size so the corner doesn't jump.
  const labelHasExplicitSize = !isStickyNote && annotation.autoSize === false
  const handleLabelResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const startW = labelHasExplicitSize
      ? annotation.size.width
      : (labelWrapperRef.current?.offsetWidth ?? 120)
    const startH = labelHasExplicitSize
      ? annotation.size.height
      : (labelWrapperRef.current?.offsetHeight ?? 32)
    const handleMove = (ev: MouseEvent) => {
      const zoom = canvasApi.getState().zoomLevel
      const dw = (ev.clientX - startX) / zoom
      const dh = (ev.clientY - startY) / zoom
      const w = startW + dw
      const h = startH + dh
      canvasApi.getState().resizeAnnotation(annotation.id, { width: w, height: h })
    }
    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
  }, [annotation.id, labelHasExplicitSize, annotation.size.width, annotation.size.height, canvasApi])

  return (
    <>
      <div
        ref={(el) => { labelWrapperRef.current = el; rootRef.current = el }}
        style={{
          position: 'absolute',
          left: annotation.origin.x,
          top: annotation.origin.y,
          width: isStickyNote
            ? annotation.size.width
            : (labelHasExplicitSize ? annotation.size.width : 'auto'),
          minWidth: isStickyNote ? undefined : 40,
          maxWidth: isStickyNote ? undefined : undefined,
          height: isStickyNote
            ? annotation.size.height
            : (labelHasExplicitSize ? annotation.size.height : 'auto'),
          backgroundColor: annotation.color,
          borderRadius: isStickyNote ? 8 : 4,
          border: isStickyNote ? `1px solid var(--border-subtle)` : 'none',
          padding: isStickyNote ? '14px 16px' : '4px 6px',
          cursor: isEditing ? 'text' : 'grab',
          zIndex: -500, // Between regions (-1000) and panels (0+)
          boxShadow,
          outline: !isStickyNote ? labelOutline : undefined,
          outlineOffset: labelOutlineOffset,
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
              data-annotation-content="true"
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
                  whiteSpace: 'pre',
                  overflowWrap: 'normal',
                  wordBreak: 'normal',
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
                  whiteSpace: 'pre',
                  overflowWrap: 'normal',
                  wordBreak: 'normal',
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
              <div
                data-annotation-content={isStickyNote ? 'true' : undefined}
                style={{
                color: textColor,
                fontSize: isStickyNote ? currentFontSize : labelFontSize,
                fontWeight: isStickyNote ? (annotation.bold ? 700 : 500) : labelFontWeight,
                whiteSpace: isStickyNote ? 'pre-wrap' : 'pre',
                overflow: isStickyNote ? 'auto' : (labelHasExplicitSize ? 'hidden' : 'visible'),
                width: isStickyNote ? '100%' : (labelHasExplicitSize ? '100%' : 'auto'),
                height: isStickyNote ? '100%' : (labelHasExplicitSize ? '100%' : 'auto'),
                lineHeight: 1.45,
                overflowWrap: isStickyNote ? 'break-word' : 'normal',
                wordBreak: 'normal',
              }}>
                {annotation.content}
              </div>
            )}
          </>
        )}
        {!isStickyNote && hovered && !isEditing && (
          <div
            onMouseDown={handleLabelResizeMouseDown}
            title="Drag to resize"
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
