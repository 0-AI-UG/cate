// The floating canvas toolbar: tools, new panel buttons, zoom, and the
// minimap pill. It lays out as a bottom-centred bar on a wide canvas and
// collapses to one expandable button on a narrow one.

import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { Hand, Map as MapTrifold, Minus, MousePointer2 as Cursor, Plus } from 'lucide-react'
import { AttachedFlyout, Icon, Tooltip, useHoverIntent } from '../../../kernel/interaction'
import { isIconName } from '@kernel/interaction/contract'
import { newPanelActionId } from '@client/host'
import type { AnyPanelDefinition } from '@panels/framework/contract'
import { canvasHost } from './ports'
import { createPanelOnCanvas } from './actions'
import { canvasViewFor } from './registry'
import { cornerFromPoint } from './parts/corners'
import { canvasAtPoint, canvasContainerFor } from './parts/dom'
import { useCanvasView, useCanvasViewStore } from './context'
import { CanvasToolbarButton } from './CanvasToolbarButton'
import { canvasToolbarItems, spawnFlyoutFor, subscribeCanvasToolbarItems, subscribeSpawnFlyouts, type CanvasToolbarItem } from './toolbarItems'
import { useCanvasToolbarAction } from './toolbarAction'
import { useCanvasUi } from './uiState'
import Minimap from './Minimap'
import { KeepAwakeButton } from './KeepAwakeButton'
import { RecentScreenshotButton } from './RecentScreenshotButton'
import { originCentredOn } from '@workspace/canvas/contract'

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
// a drag onto a canvas drops the panel centred on the cursor. Resting on it
// shows the type's spawn flyout, when a module registered one.
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
  const flyout = useSyncExternalStore(subscribeSpawnFlyouts, () => spawnFlyoutFor(definition.type))
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [flyoutAnchor, setFlyoutAnchor] = useState<DOMRect | null>(null)
  const [flyoutShown, setFlyoutShown] = useState(false)
  // On the horizontal toolbar the flyout is a card that slides out of the bar
  // above the button; on the compact column it floats to the left.
  const attached = !!flyout && placement === 'top'

  const hover = useHoverIntent({
    enabled: !!flyout,
    open: () => setFlyoutAnchor((anchor) => anchor ?? wrapperRef.current?.getBoundingClientRect() ?? null),
    close: () => closeFlyout(),
  })
  const closeFlyout = () => {
    hover.cancel()
    setFlyoutAnchor(null)
    setFlyoutShown(false)
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    closeFlyout()
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
        position: originCentredOn(center, size),
      })
    }
    window.addEventListener('mousemove', onMove, true)
    window.addEventListener('mouseup', onUp, true)
  }

  return (
    <div
      ref={wrapperRef}
      className="flex shrink-0 items-center rounded-md"
      onMouseEnter={hover.enter}
      onMouseLeave={hover.leave}
    >
      <CanvasToolbarButton
        onClick={() => {
          closeFlyout()
          if (justDragged.current) { justDragged.current = false; return }
          createPanelOnCanvas(workspaceId, canvasId, definition.type)
        }}
        onMouseDown={definition.canLiveOnCanvas ? handleMouseDown : undefined}
        action={newPanelActionId(definition.type)}
        label={`New ${definition.label.toLowerCase()}`}
        tooltipPlacement={placement}
        tooltipSuppressed={!!flyoutAnchor && flyoutShown}
      >
        <DefinitionIcon definition={definition} size={16} />
      </CanvasToolbarButton>
      {attached && flyout && (
        <AttachedFlyout
          bar={wrapperRef.current?.closest<HTMLElement>('[data-toolbar-card]') ?? wrapperRef.current}
          open={!!flyoutAnchor}
          onMouseEnter={hover.cancel}
          onMouseLeave={hover.leave}
          className="flex justify-center p-1"
        >
          <flyout.Component workspaceId={workspaceId} canvasId={canvasId} side="right" onClose={closeFlyout} onShown={setFlyoutShown} />
        </AttachedFlyout>
      )}
      {flyout && !attached && flyoutAnchor && createPortal(
        <div
          className="fixed z-[90]"
          style={{ right: window.innerWidth - flyoutAnchor.left, bottom: window.innerHeight - flyoutAnchor.bottom, paddingRight: 10 }}
          onMouseEnter={hover.cancel}
          onMouseLeave={hover.leave}
        >
          <flyout.Component workspaceId={workspaceId} canvasId={canvasId} side="left" onClose={closeFlyout} onShown={setFlyoutShown} />
        </div>,
        document.body,
      )}
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
    </div>
  )
}

/** The zoom and map card: as wide as its controls closed, as wide as the map open. */
const DOCK_WIDTH_CLOSED = 148
const DOCK_WIDTH_OPEN = 176
const MAP_HEIGHT = 112
/** Bottom offset that centres the 36px toolbar and zoom card on the sidebar's
 *  bottom icon row (32px buttons centred 24px above the window edge). */
const CONTROLS_BOTTOM = 6
/** The window's corner radius, so a card tucked into the bottom-right corner
 *  (the same CONTROLS_BOTTOM from both edges) is concentric with it. */
const WINDOW_RADIUS = 18
const CORNER_CARD_RADIUS = WINDOW_RADIUS - CONTROLS_BOTTOM
/** How far the controls row overlaps the map's faded end: exactly the row's
 *  height, so the map ends where the row does and never hangs past the card. */
const MAP_OVERLAP = 28

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

  // Keep the map mounted while the card folds shut, so it collapses as
  // smoothly as it opens instead of emptying first.
  const [mapMounted, setMapMounted] = useState(minimapOpen)
  useEffect(() => {
    if (minimapOpen) { setMapMounted(true); return }
    const timer = setTimeout(() => setMapMounted(false), 260)
    return () => clearTimeout(timer)
  }, [minimapOpen])
  const fade = mmBottom ? 'to bottom' : 'to top'
  const minimapWidth = minimapOpen ? DOCK_WIDTH_OPEN : DOCK_WIDTH_CLOSED
  const bottomLeftInset = mmBottom && !mmRight ? 16 + minimapWidth + 8 : 16
  const bottomRightInset = mmBottom && mmRight ? CONTROLS_BOTTOM + minimapWidth + 8 : 16
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
  const divider = <div className={isHorizontal ? 'w-px h-3 bg-surface-5 mx-0.5 shrink-0' : 'h-px w-4 bg-surface-5 my-0.5'} />
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

  const spawnButton = (definition: AnyPanelDefinition) => (
    <SpawnButton key={definition.type} definition={definition} workspaceId={workspaceId} canvasId={canvasId} placement={place} />
  )
  // Every tool stays in view. Only the terminal's agents open on hover.
  const items = isHorizontal ? (
    <>
      <CanvasToolbarButton onClick={() => setActiveTool('select')} action="selectTool" label="Select tool" active={activeTool === 'select'} tooltipPlacement={place}>
        <Cursor size={16} />
      </CanvasToolbarButton>
      <CanvasToolbarButton onClick={() => setActiveTool('hand')} action="handTool" label="Hand tool" active={activeTool === 'hand'} tooltipPlacement={place}>
        <Hand size={16} />
      </CanvasToolbarButton>
      {renderItems('tools')}
      {divider}
      {spawnable.map(spawnButton)}
      {renderItems('create')}
      {divider}
      <KeepAwakeButton workspaceId={workspaceId} tooltipPlacement={place} />
    </>
  ) : (
    <>
      <KeepAwakeButton workspaceId={workspaceId} tooltipPlacement={place} />
      {divider}
      <CanvasToolbarButton onClick={() => setActiveTool('select')} action="selectTool" label="Select tool" active={activeTool === 'select'} tooltipPlacement={place}>
        <Cursor size={16} />
      </CanvasToolbarButton>
      <CanvasToolbarButton onClick={() => setActiveTool('hand')} action="handTool" label="Hand tool" active={activeTool === 'hand'} tooltipPlacement={place}>
        <Hand size={16} />
      </CanvasToolbarButton>
      {renderItems('tools')}
      {divider}
      {spawnable.map(spawnButton)}
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
        <div className="absolute inset-x-0 z-50 flex justify-center pointer-events-none" style={{ bottom: CONTROLS_BOTTOM }}>
          <div
            ref={horizontalCardRef}
            data-onboarding="toolbar"
            data-toolbar-card
            className="relative shrink-0 w-max pointer-events-auto rounded-xl bg-surface-1 bar-outline"
          >
            <div className="flex flex-nowrap items-center gap-0.5 p-1">
              {items}
            </div>
          </div>
        </div>
      ) : (
        <div className="absolute z-50 pointer-events-none" style={{ right: bottomRightInset, bottom: CONTROLS_BOTTOM }}>
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
                className="rounded-xl bg-surface-1 bar-outline flex flex-col-reverse items-center gap-px p-0.5"
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
                className={`w-7 h-7 flex items-center justify-center rounded-xl bg-surface-1 bar-outline ${expanded ? 'text-primary' : 'text-secondary'} hover:text-primary active:scale-[0.94] focus:outline-none focus-visible:outline-none transition-colors duration-100`}
              >
                <ToolIcon size={16} />
              </button>
            </Tooltip>
          </div>
        </div>
      )}

      {/* One card: zoom controls with the map above (or below, in a top corner)
          them. Closed it is the same width, so it never jumps. */}
      <div
        className="absolute z-50 pointer-events-auto"
        style={{
          ...(mmBottom ? { bottom: CONTROLS_BOTTOM } : { top: '1rem' }),
          ...(mmRight ? { right: mmBottom ? CONTROLS_BOTTOM : '1rem' } : { left: '1rem' }),
          width: minimapWidth,
          transition: 'width 220ms cubic-bezier(0.2, 0.8, 0.2, 1)',
        }}
      >
        <div
          className="absolute"
          style={{
            ...(mmBottom ? { bottom: 'calc(100% + 8px)' } : { top: 'calc(100% + 8px)' }),
            ...(mmRight ? { right: 2 } : { left: 2 }),
          }}
        >
          <RecentScreenshotButton workspaceId={workspaceId} expandDown={!mmBottom} />
        </div>
        <div
          data-testid="minimap-toggle"
          className={`flex ${mmBottom ? 'flex-col' : 'flex-col-reverse'} overflow-hidden bg-surface-1 bar-outline p-1`}
          style={{ borderRadius: mmBottom && mmRight ? CORNER_CARD_RADIUS : 12 }}
        >
          {/* The map is the card's backdrop: it fades out toward the controls and
              blurs progressively behind them, so the buttons stay readable. */}
          <div className="canvas-map" data-open={minimapOpen || undefined}>
            <div className="canvas-map-inner rounded-lg">
              {mapMounted && (
                <div className="relative" style={{ height: MAP_HEIGHT }}>
                  <Minimap workspaceId={workspaceId} fade={fade} />
                </div>
              )}
            </div>
          </div>
          <div className="relative z-10 flex items-center justify-between" style={{ [mmBottom ? 'marginTop' : 'marginBottom']: minimapOpen ? -MAP_OVERLAP : 0, transition: 'margin 220ms cubic-bezier(0.2, 0.8, 0.2, 1)' }}>
            <CanvasToolbarButton onClick={() => store.getState().animateZoomTo(zoom - 0.1)} action="zoomOut" label="Zoom out">
              <Minus size={16} />
            </CanvasToolbarButton>
            <Tooltip action="zoomReset" label="Reset zoom" placement="top">
              <button
                type="button"
                onClick={() => store.getState().animateZoomTo(1.0)}
                aria-label="Reset zoom"
                style={{ WebkitTapHighlightColor: 'transparent' }}
                className="text-[11px] tabular-nums text-muted hover:text-primary min-w-[40px] text-center select-none rounded-lg bg-transparent hover:bg-hover-strong cursor-pointer h-7 px-1.5 focus:outline-none focus-visible:outline-none transition-colors duration-100"
              >
                {zoomText}
              </button>
            </Tooltip>
            <CanvasToolbarButton onClick={() => store.getState().animateZoomTo(zoom + 0.1)} action="zoomIn" label="Zoom in">
              <Plus size={16} />
            </CanvasToolbarButton>
            <div className="w-px h-3 bg-surface-5 mx-0.5 shrink-0" />
            {/* The map toggle doubles as a handle: a drag re-docks the card to the corner the cursor ends in. */}
            <Tooltip action="toggleMinimap" label={`${minimapOpen ? 'Hide' : 'Show'} minimap`}>
              <button
                type="button"
                onMouseDown={handleMinimapHandleMouseDown}
                onClick={handleMinimapToggleClick}
                aria-label={minimapOpen ? 'Hide minimap' : 'Show minimap'}
                aria-pressed={minimapOpen}
                style={{ WebkitTapHighlightColor: 'transparent' }}
                className={`h-7 w-7 shrink-0 flex items-center justify-center rounded-lg hover:bg-hover-strong hover:text-primary active:scale-[0.94] focus:outline-none focus-visible:outline-none transition-colors duration-100 ${minimapOpen ? 'bg-hover-strong text-primary' : 'text-muted'}`}
              >
                <MapTrifold size={16} />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
    </>
  )
}

export default React.memo(CanvasToolbar)
