// The canvas surface: background, grid, worktree territory, the transformed
// world that holds the nodes, and the screen-level overlay layers. Pan and
// zoom move the world with an imperative CSS transform, so the surface never
// re-renders during a gesture.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { viewToCanvas, type Point } from '@workspace/canvas/contract'
import { declaredActions } from '@kernel/interaction'
import { useDocument } from '../../document'
import { canRunAction, creationMenuItems, creationPick, runAction, worktreeChoices } from '@client/host'
import { RelationCanvasProvider } from '../../../workspace/relations'
import { registerCanvasDropSurface, useDockFileDrop } from '../drag'
import { canvasHost } from './ports'
import { useCanvasSetting } from './settingsHooks'
import { createPanelOnCanvas } from './actions'
import { useCanvasInteraction } from './useCanvasInteraction'
import { useAutoFocusLargestVisible } from './useAutoFocusLargestVisible'
import { CanvasRelationOverlayContext, CanvasTopOverlayContext, useCanvasView, useCanvasViewStore } from './context'
import { canvasSlots } from './slots'
import { useCanvasUi } from './uiState'
import { showContextMenu, type ContextMenuItem } from './contextMenu'
import CanvasGrid from './background/CanvasGrid'
import CanvasBackgroundImage from './background/CanvasBackgroundImage'
import { WorktreeTerritoryLayer } from './worktree'
import SnapGuides from './SnapGuides'
import PanelTargetLayer, { PlacementHint } from './PanelTargetLayer'

// Shared by every canvas, injected once.
let styleInjected = false
function injectInteractionStyle(): void {
  if (styleInjected) return
  styleInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .canvas-interacting iframe,
    .canvas-interacting webview,
    .canvas-interacting .monaco-editor,
    .canvas-interacting .xterm,
    .canvas-interacting .xterm-screen,
    .canvas-interacting .xterm-helper-textarea {
      pointer-events: none !important;
    }
    .canvas-dragging [data-browser-surface],
    .canvas-interacting [data-browser-surface] {
      pointer-events: none !important;
    }
    .canvas-interacting .xterm,
    .canvas-interacting .xterm * {
      cursor: grabbing !important;
    }
    /* Keep each card on its own compositor layer while zooming, so live panel
       pixels are reused instead of repainting Monaco and xterm every frame.
       Removed after settling so idle layers cost no memory. */
    .canvas-world-zooming [data-node-id] {
      will-change: transform;
    }
    /* Hand tool: presses on panel content fall through to the pan handler. */
    .canvas-tool-hand iframe,
    .canvas-tool-hand webview,
    .canvas-tool-hand .monaco-editor,
    .canvas-tool-hand .xterm,
    .canvas-tool-hand .xterm-screen,
    .canvas-tool-hand .xterm-helper-textarea {
      pointer-events: none !important;
      cursor: grab !important;
    }
    /* Hand tool: nodes are inert, only the grab cursor shows. */
    .canvas-tool-hand [data-node-id],
    .canvas-tool-hand [data-node-id] *,
    .canvas-tool-hand [data-resize-frame-for],
    .canvas-tool-hand [data-resize-frame-for] * {
      cursor: grab !important;
    }
    .canvas-tool-hand [data-node-id] [data-panel-content],
    .canvas-tool-hand [data-grab-button],
    .canvas-tool-hand [data-resize-overlay] {
      pointer-events: none !important;
    }
    .canvas-interacting.canvas-tool-hand [data-node-id],
    .canvas-interacting.canvas-tool-hand [data-node-id] *,
    .canvas-interacting.canvas-tool-hand [data-resize-frame-for],
    .canvas-interacting.canvas-tool-hand [data-resize-frame-for] * {
      cursor: grabbing !important;
    }
  `
  document.head.appendChild(style)
}

const WORLD_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  width: 1,
  height: 1,
  transformOrigin: '0 0',
}

const OVERLAY_WORLD_STYLE: React.CSSProperties = { ...WORLD_STYLE, pointerEvents: 'none' }

export interface CanvasProps {
  workspaceId: string
  canvasId: string
  canvasPanelId: string
  children?: React.ReactNode
  /** Screen-space chrome that must stay above browser surfaces. */
  overlayChildren?: React.ReactNode
}

function Marquee(): React.ReactElement | null {
  const marquee = useCanvasView((s) => s.marquee)
  if (!marquee) return null
  return (
    <div
      data-canvas-marquee
      style={{
        position: 'absolute',
        left: Math.min(marquee.startX, marquee.currentX),
        top: Math.min(marquee.startY, marquee.currentY),
        width: Math.abs(marquee.currentX - marquee.startX),
        height: Math.abs(marquee.currentY - marquee.startY),
        backgroundColor: 'rgba(74, 158, 255, 0.1)',
        border: '1px solid rgba(74, 158, 255, 0.5)',
        borderRadius: 2,
        pointerEvents: 'none',
        zIndex: 99999,
      }}
    />
  )
}

export default function Canvas({ workspaceId, canvasId, canvasPanelId, children, overlayChildren }: CanvasProps): React.ReactElement {
  const canvasRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const topOverlayRef = useRef<HTMLDivElement>(null)
  const topOverlayWorldRef = useRef<HTMLDivElement | null>(null)
  const relationOverlayRef = useRef<HTMLDivElement>(null)
  const relationOverlayWorldRef = useRef<HTMLDivElement | null>(null)
  const [topOverlayWorld, setTopOverlayWorld] = useState<HTMLDivElement | null>(null)
  const [relationOverlayWorld, setRelationOverlayWorld] = useState<HTMLDivElement | null>(null)
  const setTopOverlayWorldRef = useCallback((element: HTMLDivElement | null) => {
    topOverlayWorldRef.current = element
    setTopOverlayWorld(element)
  }, [])
  const setRelationOverlayWorldRef = useCallback((element: HTMLDivElement | null) => {
    relationOverlayWorldRef.current = element
    setRelationOverlayWorld(element)
  }, [])
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const store = useCanvasViewStore()
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })

  const handToolActive = useCanvasUi((s) => s.activeTool === 'hand')
  const showWorktreeTerritory = useCanvasSetting('showWorktreeTerritory')
  const worktrees = useDocument(workspaceId, (d) => d.worktrees)
  const worktreeList = useMemo(() => worktreeChoices(worktrees), [worktrees])

  // Under the hand tool, a left press anywhere pans (see .canvas-tool-hand).
  useEffect(() => {
    document.body.classList.toggle('canvas-tool-hand', handToolActive)
    return () => document.body.classList.remove('canvas-tool-hand')
  }, [handToolActive])

  const {
    handleWheel,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleContextMenu,
    canvasContextMenu,
    closeCanvasContextMenu,
  } = useCanvasInteraction(canvasRef, store)

  useEffect(injectInteractionStyle, [])

  // Pan and zoom write the transform straight to the DOM.
  useEffect(() => {
    const applyTransform = (zoom: number, offset: Point, zoomChanged = false) => {
      const transform = `scale(${zoom}) translate(${offset.x / zoom}px, ${offset.y / zoom}px)`
      const layers = [worldRef.current, topOverlayWorldRef.current, relationOverlayWorldRef.current]
      if (!layers.some(Boolean)) return
      for (const el of layers) {
        if (!el) continue
        el.style.transform = transform
      }
      // Native guests sit outside the world; realign them in this same task
      // or they trail their nodes by a frame while panning.
      canvasSlots().syncSurfaces()
      // Promote the world to a GPU layer for the gesture, then drop it once
      // settled: while promoted Chromium scales the cached texture and thin
      // icon strokes blur; removing will-change re-rasters them crisp.
      for (const el of layers) if (el) el.style.willChange = 'transform'
      if (zoomChanged) worldRef.current?.classList.add('canvas-world-zooming')
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current)
      settleTimerRef.current = setTimeout(() => {
        for (const el of [worldRef.current, topOverlayWorldRef.current, relationOverlayWorldRef.current]) {
          if (el) el.style.willChange = 'auto'
        }
        worldRef.current?.classList.remove('canvas-world-zooming')
        settleTimerRef.current = null
      }, 150)
    }
    const { zoomLevel, viewportOffset } = store.getState()
    applyTransform(zoomLevel, viewportOffset)
    const unsubscribe = store.subscribe((state, prev) => {
      if (state.zoomLevel !== prev.zoomLevel || state.viewportOffset !== prev.viewportOffset) {
        applyTransform(state.zoomLevel, state.viewportOffset, state.zoomLevel !== prev.zoomLevel)
      }
    })
    return () => {
      unsubscribe()
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current)
      worldRef.current?.classList.remove('canvas-world-zooming')
    }
  }, [store])

  // The browser host is fixed at the window root, outside this canvas's
  // stacking context. Keep the fixed overlays clipped to the canvas box.
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const sync = () => {
      const rect = canvas.getBoundingClientRect()
      for (const overlay of [topOverlayRef.current, relationOverlayRef.current]) {
        if (!overlay) continue
        overlay.style.left = `${rect.left}px`
        overlay.style.top = `${rect.top}px`
        overlay.style.width = `${rect.width}px`
        overlay.style.height = `${rect.height}px`
      }
    }
    sync()
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync)
    resize?.observe(canvas)
    window.addEventListener('resize', sync)
    window.addEventListener('scroll', sync, true)
    return () => {
      resize?.disconnect()
      window.removeEventListener('resize', sync)
      window.removeEventListener('scroll', sync, true)
    }
  }, [])

  useAutoFocusLargestVisible(store)

  // A passive React wheel listener would ignore preventDefault.
  const handleWheelRef = useRef(handleWheel)
  handleWheelRef.current = handleWheel
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => handleWheelRef.current(e as unknown as React.WheelEvent<HTMLDivElement>)
    el.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => el.removeEventListener('wheel', onWheel, { capture: true })
  }, [])

  // The canvas-space pointer anchors placement recommendations. rAF throttled
  // and non-reactive, so it never re-renders.
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    let pending: { clientX: number; clientY: number } | null = null
    let raf = 0
    const flush = () => {
      raf = 0
      if (!pending) return
      const rect = el.getBoundingClientRect()
      const { zoomLevel, viewportOffset } = store.getState()
      store.getState().setPlacementPointer(viewToCanvas({ x: pending.clientX - rect.left, y: pending.clientY - rect.top }, zoomLevel, viewportOffset))
    }
    const onMove = (e: MouseEvent) => {
      pending = { clientX: e.clientX, clientY: e.clientY }
      if (!raf) raf = requestAnimationFrame(flush)
    }
    el.addEventListener('mousemove', onMove)
    return () => {
      el.removeEventListener('mousemove', onMove)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [store])

  // Track the container size, and keep content anchored to the edge that
  // stayed put when the other one moves: a right sidebar or split divider
  // pushing in should push content by its width, not slide it under. A window
  // resize also moves the right edge but must not chase content, and a large
  // one-shot jump (a split appearing) is structural, not a push.
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    let prevRect = el.getBoundingClientRect()
    let prevWindowWidth = window.innerWidth
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const size = { width: entry.contentRect.width, height: entry.contentRect.height }
        setContainerSize(size)
        store.getState().setContainerSize(size)
      }
      const rect = el.getBoundingClientRect()
      const windowResized = window.innerWidth !== prevWindowWidth
      const dLeft = rect.left - prevRect.left
      const dRight = rect.right - prevRect.right
      prevRect = rect
      prevWindowWidth = window.innerWidth
      const structuralJump = Math.abs(dRight) > rect.width * 0.25
      if (!windowResized && !structuralJump && Math.abs(dLeft) < 0.5 && Math.abs(dRight) > 0.5) {
        const { viewportOffset } = store.getState()
        store.setState({ viewportOffset: { x: viewportOffset.x + dRight, y: viewportOffset.y } })
      }
    })
    observer.observe(el)
    const initial = { width: el.clientWidth, height: el.clientHeight }
    setContainerSize(initial)
    store.getState().setContainerSize(initial)
    return () => observer.disconnect()
  }, [store])

  const handleWorldClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    // While picking a spot: a ghost commits itself, another node re-targets,
    // empty canvas cancels.
    if (store.getState().pendingPanelTarget) {
      if (!target.closest('[data-panel-target]') && !target.closest('[data-node-id]')) store.getState().cancelPanelTarget()
      return
    }
    if (!target.closest('[data-node-id]')) {
      store.getState().unfocus()
      useCanvasUi.getState().clearWorktreeLens()
    }
  }, [store])

  const canvasPointOf = useCallback((clientX: number, clientY: number): Point | null => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return null
    const { zoomLevel, viewportOffset } = store.getState()
    return viewToCanvas({ x: clientX - rect.left, y: clientY - rect.top }, zoomLevel, viewportOffset)
  }, [store])

  // The drag layer hit-tests this surface for node moves and canvas drops.
  useEffect(() => registerCanvasDropSurface({
    workspaceId,
    canvasId,
    getElement: () => canvasRef.current,
    getViewport: () => ({ offset: store.getState().viewportOffset, zoom: store.getState().zoomLevel }),
  }), [workspaceId, canvasId, store])

  // Files open where they are dropped, as new nodes next to each other.
  const dropPointRef = useRef<Point | null>(null)
  const fileDrop = useDockFileDrop(workspaceId, useCallback(() => ({
    near: canvasPanelId,
    ...(dropPointRef.current ? { position: dropPointRef.current } : {}),
  }), [canvasPanelId]))

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes('application/cate-spawn')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      return
    }
    fileDrop.onDragOver(e)
  }, [fileDrop])

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const point = canvasPointOf(e.clientX, e.clientY)
    if (!point) return
    // A spawn button dragged out of the worktree menu opens its panel type
    // bound to that worktree, at the drop point. A worktree of another
    // workspace does not exist here: that drop is refused.
    const spawn = e.dataTransfer.getData('application/cate-spawn')
    if (spawn) {
      let spec: { workspaceId?: unknown; panelType?: unknown; cwd?: unknown; worktreeId?: unknown } = {}
      try { spec = JSON.parse(spawn) } catch { return }
      if (typeof spec.panelType !== 'string' || spec.workspaceId !== workspaceId) return
      e.preventDefault()
      e.stopPropagation()
      createPanelOnCanvas(workspaceId, canvasId, spec.panelType, {
        position: point,
        ...(typeof spec.worktreeId === 'string' ? { worktreeId: spec.worktreeId } : {}),
        ...(typeof spec.cwd === 'string' ? { cwd: spec.cwd } : {}),
      })
      return
    }
    dropPointRef.current = point
    fileDrop.onDrop(e)
    dropPointRef.current = null
  }, [workspaceId, canvasId, canvasPointOf, fileDrop])

  // A right click on empty canvas opens the native menu: the creation
  // entries, then the actions offered in the canvas menu, run on this canvas.
  useEffect(() => {
    if (!canvasContextMenu) return
    let cancelled = false
    const point = canvasContextMenu.canvasPoint
    const context = { workspaceId, canvasId }
    const actions = declaredActions().filter(({ id, spec }) => spec.contextMenus?.includes('canvas') && canRunAction(id, context))
    const items: ContextMenuItem[] = [
      ...creationMenuItems(canvasHost().creatable(), worktreeList),
      ...(actions.length > 0 ? [{ type: 'separator' as const }] : []),
      ...actions.map(({ id, spec }) => ({ id: `action:${id}`, label: spec.title })),
    ]
    void showContextMenu(items).then((id) => {
      if (cancelled) return
      closeCanvasContextMenu()
      if (id?.startsWith('action:')) {
        void runAction(id.slice('action:'.length), context)
        return
      }
      const pick = creationPick(id, worktreeList)
      if (pick) createPanelOnCanvas(workspaceId, canvasId, pick.type, { position: point, ...pick.options })
    })
    return () => { cancelled = true }
  }, [canvasContextMenu, closeCanvasContextMenu, workspaceId, canvasId, worktreeList])

  return (
    <CanvasTopOverlayContext.Provider value={topOverlayWorld}>
      <CanvasRelationOverlayContext.Provider value={relationOverlayWorld}>
        <div
          ref={canvasRef}
          data-canvas-container
          data-workspace-id={workspaceId}
          data-canvas-id={canvasId}
          data-canvas-panel-id={canvasPanelId}
          data-filedrop="canvas"
          data-filedrop-label="Drop to open on canvas"
          // overflow-clip, not hidden: a hidden box still scrolls
          // programmatically, and a caret at a panel's far edge would scroll
          // the grid and wallpaper sideways. The canvas pans by transform only.
          className="relative w-full h-full overflow-clip bg-canvas-bg"
          style={{ cursor: handToolActive ? 'grab' : 'default' }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onContextMenu={handleContextMenu}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          <CanvasBackgroundImage />
          {/* Screen space, so grid lines land on whole device pixels. */}
          <CanvasGrid containerWidth={containerSize.width} containerHeight={containerSize.height} />
          {showWorktreeTerritory && (
            <WorktreeTerritoryLayer workspaceId={workspaceId} containerWidth={containerSize.width} containerHeight={containerSize.height} />
          )}
          <div ref={worldRef} data-canvas-world style={WORLD_STYLE} onClick={handleWorldClick}>
            <SnapGuides />
            <RelationCanvasProvider canvas={store} overlayTarget={relationOverlayWorld}>
              {children}
            </RelationCanvasProvider>
          </div>
        </div>

        {/* Portals keep React event ancestry, so chrome and targets live
            outside the gesture container: their clicks must not clear the
            selection or start a marquee before the action runs. */}
        {createPortal(
          <div
            ref={topOverlayRef}
            data-canvas-top-overlay={canvasPanelId}
            style={{ position: 'fixed', overflow: 'clip', pointerEvents: 'none', zIndex: 1 }}
          >
            <div ref={setTopOverlayWorldRef} data-canvas-top-overlay-world style={OVERLAY_WORLD_STYLE}>
              <Marquee />
              <PanelTargetLayer canvasRef={canvasRef} />
            </div>
            {overlayChildren}
          </div>,
          document.body,
        )}
        {createPortal(
          <div
            ref={relationOverlayRef}
            data-canvas-relation-overlay={canvasPanelId}
            style={{ position: 'fixed', overflow: 'clip', pointerEvents: 'none', zIndex: 99999 }}
          >
            <div ref={setRelationOverlayWorldRef} data-canvas-relation-overlay-world style={OVERLAY_WORLD_STYLE} />
          </div>,
          document.body,
        )}
        <PlacementHint canvasRef={canvasRef} />
      </CanvasRelationOverlayContext.Provider>
    </CanvasTopOverlayContext.Provider>
  )
}
