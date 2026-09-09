import React, { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import type { PanelType } from '../../shared/types'
import { DockTabContextMenu, type SplitMenuItem } from './DockTabContextMenu'
import { Tooltip } from '../ui/Tooltip'
import { useCanvasTopOverlayTarget } from '../canvas/CanvasTopOverlayContext'

export function NewTabButton({ compact, canvasAttached, items, onPick }: {
  compact?: boolean
  canvasAttached?: boolean
  items: SplitMenuItem[]
  onPick: (type: PanelType) => void
}) {
  const canvasOverlay = useCanvasTopOverlayTarget()
  const portalTarget = canvasAttached ? canvasOverlay : null
  const getPosition = useCallback((rect: DOMRect) => {
    if (portalTarget) {
      const world = portalTarget.getBoundingClientRect()
      const scale = world.width / portalTarget.offsetWidth || 1
      return {
        top: (rect.bottom - world.top) / scale + 4,
        right: portalTarget.offsetWidth - (rect.left - world.left) / scale - 220,
      }
    }
    return {
      top: rect.bottom + 4,
      right: Math.max(8, window.innerWidth - Math.max(8, rect.left) - 220),
    }
  }, [portalTarget])
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null)
  const open = !!position
  useLayoutEffect(() => {
    if (!open) return
    let frame: number
    // Canvas pan/zoom uses transforms, which do not trigger resize observers.
    const trackAnchor = () => {
      const rect = buttonRef.current?.getBoundingClientRect()
      if (rect) {
        const { top, right } = getPosition(rect)
        setPosition(current => !current || (current.top === top && current.right === right)
          ? current : { top, right })
      }
      frame = requestAnimationFrame(trackAnchor)
    }
    trackAnchor()
    return () => cancelAnimationFrame(frame)
  }, [open, getPosition])
  const close = useCallback(() => {
    setPosition(null)
    buttonRef.current?.focus()
  }, [])
  return <>
    <Tooltip label="New Tab">
      <button
        ref={buttonRef}
        type="button"
        aria-label="New Tab"
        aria-haspopup="menu"
        aria-expanded={!!position}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        className={`flex shrink-0 items-center justify-center self-center rounded-[10px] text-muted hover:text-primary hover:bg-hover transition-colors duration-100 motion-reduce:transition-none cursor-pointer ${compact ? 'w-[22px] h-[22px]' : 'w-6 h-6'} ${position ? 'bg-hover text-primary' : ''}`}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          setPosition((current) => current ? null : getPosition(rect))
        }}
      ><Plus size={compact ? 12 : 13} /></button>
    </Tooltip>
    <DockTabContextMenu open={!!position} position={position} items={items} onPick={onPick} onClose={close} anchorRef={buttonRef} portalTarget={portalTarget} />
  </>
}
