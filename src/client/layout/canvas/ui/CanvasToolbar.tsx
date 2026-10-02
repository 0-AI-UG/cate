// The floating canvas toolbar: tools, new panel buttons, zoom, and the
// minimap pill. It lays out as a bottom-centred bar on a wide canvas and
// collapses to one expandable button on a narrow one.

import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { Hand, Map as MapTrifold, Minus, MousePointer2 as Cursor, Plus, X } from 'lucide-react'
import { Icon, Tooltip } from '@kernel/ui'
import { isIconName } from '@kernel/ui/contract'
import { newPanelActionId } from '@client/host'
import type { AnyPanelDefinition } from '@panels/framework/contract'
import { canvasHost } from '../ports'
import { createPanelOnCanvas } from '../actions'
import { canvasViewFor } from '../registry'
import { cornerFromPoint } from '../parts/corners'
import { canvasAtPoint, canvasContainerFor } from '../parts/dom'
import { useCanvasView, useCanvasViewStore } from './context'
import { CanvasToolbarButton } from './CanvasToolbarButton'
import { canvasToolbarItems, subscribeCanvasToolbarItems, type CanvasToolbarItem } from './toolbarItems'
import { useCanvasToolbarAction } from './toolbarAction'
import { useCanvasUi } from './uiState'
import Minimap from './Minimap'
import { KeepAwakeButton } from './KeepAwakeButton'
import { RecentScreenshotButton } from './RecentScreenshotButton'

interface CanvasToolbarProps {
  workspaceId: string
  canvasId: string
  canvasPanelId: string
}

function useToolbarItems(): CanvasToolbarItem[] {
  return useSyncExternalStore(subscribeCanvasToolbarItems, canvasToolbarItems)
}

function DefinitionIcon({ definition, size }: { definition: AnyPanelDefinition; size: number }): React.ReactElement {
  return isIconName(definition.icon) ? <Icon name={definition.icon} size={size} /> : <Plus size={size} />
}

// A new-panel button with drag-to-place: a click opens the placement picker,
// a drag onto a canvas drops the panel centred on the cursor.
function SpawnButton({ definition, workspaceId, canvasId, placement }: {
  definition: AnyPanelDefinition
  workspaceId: string
  canvasId: string
  placement: 'top' | 'right'
}): React.ReactElement {
  const store = useCanvasViewStore()
  const [ghost, setGhost] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const justDragged = useRef(false)
  const size = definition.defaultSize

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    const startX = e.clientX
    const startY = e.clientY
    let moved = false
    const onMove = (ev: MouseEvent) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return
      moved = true
      const zoom = store.getState().zoomLevel
      const w = size.width * zoom
      const h = size.height * zoom
      setGhost({ x: ev.clientX - w / 2, y: ev.clientY - h / 2, w, h })
    }
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove, true)
      window.removeEventListener('mouseup', onUp, true)
      setGhost(null)
      if (!moved) return
      justDragged.current = true
      const hit = canvasAtPoint(ev.clientX, ev.clientY)
      if (!hit || hit.workspaceId !== workspaceId) return
      // Drop onto the canvas under the cursor, which may not be this one.
      const target = canvasViewFor(hit.workspaceId, hit.canvasId)
      if (!target) return
      const center = target.getState().viewToCanvas({ x: ev.clientX - hit.rect.left, y: ev.clientY - hit.rect.top })
      createPanelOnCanvas(workspaceId, hit.canvasId, definition.type, {
        position: { x: center.x - size.width / 2, y: center.y - size.height / 2 },
      })
    }
    window.addEventListener('mousemove', onMove, true)
    window.addEventListener('mouseup', onUp, true)
  }

  return (
    <>
      <CanvasToolbarButton
        onClick={() => {
          if (justDragged.current) { justDragged.current = false; return }
          createPanelOnCanvas(workspaceId, canvasId, definition.type)
        }}
        onMouseDown={definition.canLiveOnCanvas ? handleMouseDown : undefined}
        action={newPanelActionId(definition.type)}
        label={`New ${definition.label.toLowerCase()}`}
        size="panel"
        tooltipPlacement={placement}
      >
        <DefinitionIcon definition={definition} size={18} />
      </CanvasToolbarButton>
      {ghost && createPortal(
        <div
          style={{
            position: 'fixed',
            left: ghost.x, top: ghost.y, width: ghost.w, height: ghost.h,
            borderRadius: 8,
            border: '1.5px solid rgba(74, 158, 255, 0.75)',
            background: 'rgba(74, 158, 255, 0.1)',
            boxShadow: '0 12px 32px rgba(0,0,0,0.4)',
            pointerEvents: 'none',
            zIndex: 2147483000,
            overflow: 'hidden',
            backdropFilter: 'blur(1px)',
          }}
        >
          <div style={{
            height: 22, background: 'rgba(74, 158, 255, 0.22)',
            display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px',
            color: 'rgba(255,255,255,0.9)', fontSize: 11, fontWeight: 600,
            fontFamily: 'var(--font-sans)',
          }}>
            <DefinitionIcon definition={definition} size={12} /> {definition.label}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

function CanvasToolbar({ workspaceId, canvasId, canvasPanelId }: CanvasToolbarProps): React.ReactElement {
  const store = useCanvasViewStore()
  const zoom = useCanvasView((s) => s.zoomLevel)
  const minimapOpen = useCanvasUi((s) => !!s.minimapOpen[canvasId])
  const toggleMinimap = useCanvasUi((s) => s.toggleMinimap)
  const activeTool = useCanvasUi((s) => s.activeTool)
  const setActiveTool = useCanvasUi((s) => s.setActiveTool)
  const minimapCorner = useCanvasUi((s) => s.minimapCorner)
  const extraItems = useToolbarItems()
  const zoomText = `${Math.round(zoom * 100)}%`

  // The creatable types the toolbar offers.
  const spawnable = canvasHost().creatable({ onCanvas: true }).filter((d) => d.creation?.toolbar)

  // Collapse before the centred bar would be clipped or overlap a
  // bottom-corner minimap.
  const horizontalCardRef = useRef<HTMLDivElement>(null)
  const [areaWidth, setAreaWidth] = useState(0)
  const [toolbarWidth, setToolbarWidth] = useState(0)
  const mmBottom = minimapCorner.startsWith('bottom')
  const mmRight = minimapCorner.endsWith('right')

  useEffect(() => {
    const area = canvasContainerFor(canvasId)
    if (!area) return
    const measure = () => setAreaWidth(area.clientWidth)
    const ro = new ResizeObserver(measure)
    ro.observe(area)
    measure()
    return () => ro.disconnect()
  }, [canvasId])

  const minimapWidth = minimapOpen ? 220 : 44
  const bottomLeftInset = mmBottom && !mmRight ? 16 + minimapWidth + 8 : 16
  const bottomRightInset = mmBottom && mmRight ? 16 + minimapWidth + 8 : 16
  const centeredLeft = (areaWidth - toolbarWidth) / 2
  const centeredRight = centeredLeft + toolbarWidth
  const isHorizontal = areaWidth === 0 || toolbarWidth === 0 || (
    centeredLeft >= bottomLeftInset && centeredRight <= areaWidth - bottomRightInset
  )

  useEffect(() => {
    if (!isHorizontal) return
    const card = horizontalCardRef.current
    if (!card) return
    const measure = () => {
      if (card.isConnected && card.offsetWidth > 0) setToolbarWidth(card.offsetWidth)
    }
    const ro = new ResizeObserver(measure)
    ro.observe(card)
    measure()
    return () => ro.disconnect()
  }, [isHorizontal])

  // Compact mode: the resting button expands the toolbar; an open fly-out
  // keeps it expanded until the menu closes.
  const [pinned, setPinned] = useState(false)
  useCanvasToolbarAction('toggleCanvasToolbar', canvasPanelId, () => {
    if (!isHorizontal) setPinned((value) => !value)
  })
  const [openMenus, setOpenMenus] = useState<Record<string, boolean>>({})
  const expanded = pinned || Object.values(openMenus).some(Boolean)
  const ToolIcon = activeTool === 'hand' ? Hand : Cursor

  const place: 'top' | 'right' = isHorizontal ? 'top' : 'right'
  const menuSide: 'up' | 'right' = isHorizontal ? 'up' : 'right'
  const divider = <div className={isHorizontal ? 'w-px h-5 bg-surface-5 mx-1' : 'h-px w-6 bg-surface-5 my-1'} />
  const renderItems = (group: CanvasToolbarItem['group']) => extraItems
    .filter((item) => item.group === group)
    .map((item) => (
      <item.Component
        key={item.id}
        workspaceId={workspaceId}
        canvasId={canvasId}
        canvasPanelId={canvasPanelId}
        tooltipPlacement={place}
        menuSide={menuSide}
        onOpenChange={(open) => setOpenMenus((current) => ({ ...current, [item.id]: open }))}
      />
    ))

  const items = (
    <>
      <KeepAwakeButton workspaceId={workspaceId} tooltipPlacement={place} />
      {divider}
      <CanvasToolbarButton onClick={() => setActiveTool('select')} action="selectTool" label="Select tool" active={activeTool === 'select'} tooltipPlacement={place}>
        <Cursor size={18} />
      </CanvasToolbarButton>
      <CanvasToolbarButton onClick={() => setActiveTool('hand')} action="handTool" label="Hand tool" active={activeTool === 'hand'} tooltipPlacement={place}>
        <Hand size={18} />
      </CanvasToolbarButton>
      {renderItems('tools')}
      {divider}
      {spawnable.map((definition) => (
        <SpawnButton key={definition.type} definition={definition} workspaceId={workspaceId} canvasId={canvasId} placement={place} />
      ))}
      {renderItems('create')}
    </>
  )

  // The minimap toggle doubles as a handle: a drag re-docks the pill to the
  // corner the cursor ends in.
  const minimapDidDragRef = useRef(false)
  const handleMinimapHandleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const startX = e.clientX
    const startY = e.clientY
    minimapDidDragRef.current = false
    const rect = canvasContainerFor(canvasId)?.getBoundingClientRect()
      ?? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
    const onMove = (ev: MouseEvent) => {
      if (!minimapDidDragRef.current && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return
      minimapDidDragRef.current = true
      const next = cornerFromPoint(ev.clientX, ev.clientY, rect)
      if (next !== useCanvasUi.getState().minimapCorner) useCanvasUi.getState().setMinimapCorner(next)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  const handleMinimapToggleClick = () => {
    if (minimapDidDragRef.current) {
      minimapDidDragRef.current = false
      return
    }
    toggleMinimap(canvasId)
  }

  return (
    <>
      {isHorizontal ? (
        <div className="absolute inset-x-0 bottom-4 z-50 flex justify-center pointer-events-none">
          <div
            ref={horizontalCardRef}
            data-onboarding="toolbar"
            data-toolbar-card
            className="relative shrink-0 w-max pointer-events-auto rounded-full border border-subtle bg-surface-0 shadow-[0_8px_24px_-6px_var(--shadow-node)]"
          >
            <div className="flex flex-nowrap items-center gap-0.5 px-1 py-1">
              {items}
              <div className="w-px h-5 bg-surface-5 mx-1" />
              <CanvasToolbarButton onClick={() => store.getState().animateZoomTo(zoom - 0.1)} action="zoomOut" label="Zoom out" size="zoom">
                <Minus size={16} />
              </CanvasToolbarButton>
              <Tooltip action="zoomReset" label="Reset zoom" placement="top">
                <button
                  type="button"
                  onClick={() => store.getState().animateZoomTo(1.0)}
                  aria-label="Reset zoom"
                  style={{ WebkitTapHighlightColor: 'transparent' }}
                  className="text-[11px] font-mono text-secondary hover:text-primary min-w-[40px] text-center select-none rounded-full bg-transparent hover:bg-hover-strong active:bg-hover-strong cursor-pointer px-1.5 py-1 focus:outline-none focus-visible:outline-none transition-all duration-100"
                >
                  {zoomText}
                </button>
              </Tooltip>
              <CanvasToolbarButton onClick={() => store.getState().animateZoomTo(zoom + 0.1)} action="zoomIn" label="Zoom in" size="zoom">
                <Plus size={16} />
              </CanvasToolbarButton>
            </div>
          </div>
        </div>
      ) : (
        <div className="absolute bottom-4 z-50 pointer-events-none" style={{ right: bottomRightInset }}>
          <div data-onboarding="toolbar" className="relative pointer-events-auto">
            <div
              aria-hidden={!expanded}
              style={{
                visibility: expanded ? 'visible' : 'hidden',
                position: 'absolute',
                bottom: '100%',
                right: 0,
                paddingBottom: 10,
                opacity: expanded ? 1 : 0,
                transform: expanded ? 'translateY(0)' : 'translateY(6px)',
                pointerEvents: expanded ? 'auto' : 'none',
                transition: 'opacity 160ms ease, transform 160ms cubic-bezier(0.16,1,0.3,1)',
              }}
            >
              <div
                data-toolbar-card
                className="rounded-2xl border border-subtle bg-surface-0 shadow-[0_8px_24px_-6px_var(--shadow-node)] flex flex-col-reverse items-center gap-0.5 p-1"
                style={{ maxHeight: 'calc(100vh - 100px)', overflowY: 'auto' }}
              >
                {items}
              </div>
            </div>
            <Tooltip action="toggleCanvasToolbar" label={pinned ? 'Collapse toolbar' : 'Expand toolbar'} placement="left">
              <button
                type="button"
                onClick={() => setPinned((p) => !p)}
                aria-label="Toolbar"
                aria-expanded={expanded}
                style={{ WebkitTapHighlightColor: 'transparent' }}
                className={`w-11 h-11 flex items-center justify-center rounded-full border border-subtle bg-surface-0 shadow-[0_8px_24px_-6px_var(--shadow-node)] ${expanded ? 'text-primary' : 'text-secondary'} hover:text-primary active:scale-[0.92] focus:outline-none focus-visible:outline-none transition-all duration-100`}
              >
                <ToolIcon size={18} />
              </button>
            </Tooltip>
          </div>
        </div>
      )}

      {/* The minimap pill grows toward the canvas centre while its toggle
          stays pinned to the docked corner. */}
      <div
        className="absolute z-50 flex gap-2 pointer-events-auto"
        style={{
          ...(mmBottom ? { bottom: '1rem' } : { top: '1rem' }),
          ...(mmRight ? { right: '1rem' } : { left: '1rem' }),
          flexDirection: mmRight ? 'row' : 'row-reverse',
          alignItems: mmBottom ? 'flex-end' : 'flex-start',
        }}
      >
        <div
          className="absolute"
          style={{
            ...(mmBottom ? { bottom: 'calc(100% + 12px)' } : { top: 'calc(100% + 12px)' }),
            ...(mmRight ? { right: 2 } : { left: 2 }),
          }}
        >
          <RecentScreenshotButton workspaceId={workspaceId} expandDown={!mmBottom} />
        </div>
        <div
          data-testid="minimap-toggle"
          className="relative overflow-hidden border border-subtle shadow-[0_8px_24px_-6px_var(--shadow-node)]"
          style={{
            borderRadius: 22,
            transition: 'width 300ms cubic-bezier(0.16,1,0.3,1), height 300ms cubic-bezier(0.16,1,0.3,1), background 200ms ease, backdrop-filter 200ms ease',
            width: minimapOpen ? 220 : 44,
            height: minimapOpen ? 160 : 44,
            background: minimapOpen ? 'color-mix(in srgb, var(--surface-2) 45%, transparent)' : 'var(--surface-0)',
            backdropFilter: minimapOpen ? 'blur(24px) saturate(1.5)' : 'none',
            WebkitBackdropFilter: minimapOpen ? 'blur(24px) saturate(1.5)' : 'none',
          }}
        >
          {minimapOpen && (
            <div className="absolute inset-0">
              <Minimap workspaceId={workspaceId} />
            </div>
          )}
          <Tooltip action="toggleMinimap" label={`${minimapOpen ? 'Hide' : 'Show'} minimap`}>
            <button
              type="button"
              onMouseDown={handleMinimapHandleMouseDown}
              onClick={handleMinimapToggleClick}
              aria-label={minimapOpen ? 'Hide minimap' : 'Show minimap'}
              style={{
                WebkitTapHighlightColor: 'transparent',
                position: 'absolute',
                cursor: 'grab',
                ...(mmBottom ? { bottom: -1 } : { top: -1 }),
                ...(mmRight ? { right: -1 } : { left: -1 }),
              }}
              className="w-[44px] h-[44px] flex items-center justify-center text-secondary hover:text-primary active:scale-[0.92] focus:outline-none focus-visible:outline-none transition-all duration-100 z-10"
            >
              {minimapOpen ? <X size={14} /> : <MapTrifold size={18} />}
            </button>
          </Tooltip>
        </div>
      </div>
    </>
  )
}

export default React.memo(CanvasToolbar)
