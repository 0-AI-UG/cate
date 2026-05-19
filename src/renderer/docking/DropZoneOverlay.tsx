// =============================================================================
// DropZoneOverlay — renders semi-transparent drop indicators when a dock-aware
// drag is active. Shows 5 zones: top/bottom/left/right edges for split,
// center for tab. Overlays dock zones, tab stacks, and canvas.
// =============================================================================

import React, { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDockDragStore } from '../hooks/useDockDrag'
import type { DockDropTarget } from '../../shared/types'

// -----------------------------------------------------------------------------
// Props
// -----------------------------------------------------------------------------

interface DropZoneOverlayProps {
  /** The active drop target (if cursor is over this overlay's container) */
  activeTarget: DockDropTarget | null
  /** Whether the cursor is currently over this container */
  isOver: boolean
}

// -----------------------------------------------------------------------------
// Zone indicator component
// -----------------------------------------------------------------------------

interface ZoneIndicatorProps {
  position: 'top' | 'bottom' | 'left' | 'right' | 'center'
  isActive: boolean
}

function ZoneIndicator({ position, isActive }: ZoneIndicatorProps) {
  const style = useMemo<React.CSSProperties>(() => {
    const base: React.CSSProperties = {
      position: 'absolute',
      transition: 'background-color 150ms ease, border-color 150ms ease',
      borderRadius: 4,
      pointerEvents: 'none',
    }

    const edgeFraction = '25%'
    const inset = 4

    switch (position) {
      case 'top':
        return {
          ...base,
          top: inset,
          left: inset,
          right: inset,
          height: edgeFraction,
        }
      case 'bottom':
        return {
          ...base,
          bottom: inset,
          left: inset,
          right: inset,
          height: edgeFraction,
        }
      case 'left':
        return {
          ...base,
          top: inset,
          left: inset,
          bottom: inset,
          width: edgeFraction,
        }
      case 'right':
        return {
          ...base,
          top: inset,
          right: inset,
          bottom: inset,
          width: edgeFraction,
        }
      case 'center':
        return {
          ...base,
          top: '30%',
          left: '30%',
          right: '30%',
          bottom: '30%',
        }
    }
  }, [position])

  return (
    <div
      style={{
        ...style,
        backgroundColor: isActive
          ? 'rgba(74, 158, 255, 0.35)'
          : 'rgba(74, 158, 255, 0.12)',
        border: isActive
          ? '2px solid rgba(74, 158, 255, 0.8)'
          : '2px dashed rgba(74, 158, 255, 0.35)',
      }}
    />
  )
}

// -----------------------------------------------------------------------------
// Preview indicator — shows a solid highlight where the panel will land
// -----------------------------------------------------------------------------

function DropPreview({ position }: { position: 'top' | 'bottom' | 'left' | 'right' | 'center' }) {
  const pad = 6

  const style = useMemo<React.CSSProperties>(() => {
    const base: React.CSSProperties = {
      position: 'absolute',
      backgroundColor: 'rgba(74, 158, 255, 0.12)',
      border: '2px solid rgba(74, 158, 255, 0.5)',
      borderRadius: 6,
      pointerEvents: 'none',
      transition: 'all 200ms cubic-bezier(0.25, 0.46, 0.45, 0.94)',
      animation: 'dropPreviewIn 200ms cubic-bezier(0.25, 0.46, 0.45, 0.94)',
    }

    switch (position) {
      case 'top':
        return { ...base, top: pad, left: pad, right: pad, height: `calc(50% - ${pad}px)` }
      case 'bottom':
        return { ...base, bottom: pad, left: pad, right: pad, height: `calc(50% - ${pad}px)` }
      case 'left':
        return { ...base, top: pad, left: pad, bottom: pad, width: `calc(50% - ${pad}px)` }
      case 'right':
        return { ...base, top: pad, right: pad, bottom: pad, width: `calc(50% - ${pad}px)` }
      case 'center':
        // 'center' / tab targets render an inline placeholder chip in the
        // tab list (see DockTabStack), not a full-area overlay. We hide the
        // portal preview for tab drops to avoid the duplicate blue box.
        return { ...base, display: 'none' }
    }
  }, [position])

  return (
    <>
      <style>{`
        @keyframes dropPreviewIn {
          from { opacity: 0; transform: scale(0.97); }
          to   { opacity: 1; transform: scale(1); }
        }
      `}</style>
      <div style={style} />
    </>
  )
}

// -----------------------------------------------------------------------------
// Main overlay
// -----------------------------------------------------------------------------

function resolveActiveEdge(target: DockDropTarget | null): 'top' | 'bottom' | 'left' | 'right' | 'center' | null {
  if (!target) return null
  if (target.type === 'split') return target.edge
  if (target.type === 'tab') return 'center'
  if (target.type === 'zone') return 'center'
  return null
}

export default function DropZoneOverlay({ activeTarget, isOver }: DropZoneOverlayProps) {
  const isDragging = useDockDragStore((s) => s.isDragging)
  // A hidden marker lets us look up the host container's bounding rect so we
  // can portal the preview into document.body. Portalling escapes ancestor
  // stacking contexts (canvas-node z-index trap, CanvasDropZone at z-9999)
  // that would otherwise hide the indicator.
  const markerRef = useRef<HTMLDivElement>(null)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const active = isDragging && isOver

  useLayoutEffect(() => {
    if (!active) {
      setRect(null)
      return
    }
    const measure = () => {
      const host = markerRef.current?.parentElement
      if (host) setRect(host.getBoundingClientRect())
    }
    measure()
    // The host rect can shift mid-drag (canvas panning, layout updates).
    // Subscribing to drag-store updates (cursor + target) is a cheap way to
    // re-measure every frame the drag is alive.
    const unsub = useDockDragStore.subscribe(measure)
    return () => unsub()
  }, [active])

  if (!active) return <div ref={markerRef} style={{ display: 'none' }} />

  const activeEdge = resolveActiveEdge(activeTarget)

  return (
    <>
      <div ref={markerRef} style={{ display: 'none' }} />
      {rect && createPortal(
        <div
          style={{
            position: 'fixed',
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            zIndex: 99999,
            pointerEvents: 'none',
          }}
        >
          {activeEdge && <DropPreview position={activeEdge} />}
        </div>,
        document.body,
      )}
    </>
  )
}

// -----------------------------------------------------------------------------
// DockZoneDropTarget — wraps a dock zone to show zone-level drop indicators
// when a drag is active and no dock zones are visible yet
// -----------------------------------------------------------------------------

interface DockZoneDropIndicatorProps {
  position: 'left' | 'right' | 'bottom'
  isActive: boolean
}

export function DockZoneDropIndicator({ position, isActive }: DockZoneDropIndicatorProps) {
  const isDragging = useDockDragStore((s) => s.isDragging)

  if (!isDragging || !isActive) return null

  const style: React.CSSProperties = {
    position: 'absolute',
    zIndex: 9999,
    pointerEvents: 'none',
    transition: 'all 150ms ease',
  }

  switch (position) {
    case 'left':
      Object.assign(style, {
        top: 0,
        left: 0,
        bottom: 0,
        width: 240,
        backgroundColor: 'rgba(74, 158, 255, 0.15)',
        borderRight: '2px solid rgba(74, 158, 255, 0.6)',
      })
      break
    case 'right':
      Object.assign(style, {
        top: 0,
        right: 0,
        bottom: 0,
        width: 240,
        backgroundColor: 'rgba(74, 158, 255, 0.15)',
        borderLeft: '2px solid rgba(74, 158, 255, 0.6)',
      })
      break
    case 'bottom':
      Object.assign(style, {
        left: 0,
        right: 0,
        bottom: 0,
        height: 180,
        backgroundColor: 'rgba(74, 158, 255, 0.15)',
        borderTop: '2px solid rgba(74, 158, 255, 0.6)',
      })
      break
  }

  return <div style={style} />
}
