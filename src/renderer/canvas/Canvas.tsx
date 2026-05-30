// =============================================================================
// Canvas — the main infinite canvas component.
// Ported from CanvasView.swift.
// =============================================================================

import React, { useRef, useCallback, useEffect, useMemo, useState } from 'react'
import { useCanvasStoreContext, useCanvasStoreApi, shallow } from '../stores/CanvasStoreContext'
import { useAppStore } from '../stores/appStore'
import { useCanvasInteraction } from '../hooks/useCanvasInteraction'
import { useAutoFocusLargestVisible } from '../hooks/useAutoFocusLargestVisible'
import { useUIStore, effectiveCanvasTool } from '../stores/uiStore'
import { canvasToView, viewToCanvas } from '../lib/coordinates'
import CanvasGrid from './CanvasGrid'
import SnapGuides from './SnapGuides'
import CanvasRegionComponent from './CanvasRegionComponent'
import type { Point, PanelType } from '../../shared/types'
import { openFileAsPanel } from '../lib/fileRouting'

// Module-level style injection — shared across all Canvas instances
let canvasStyleInjected = false
function injectCanvasInteractingStyle(): void {
  if (canvasStyleInjected) return
  canvasStyleInjected = true
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
    .canvas-interacting .xterm,
    .canvas-interacting .xterm * {
      cursor: grabbing !important;
    }
    /* Hand tool active (idle): let left-presses on interactive panel content
       fall through to the canvas pan handler instead of being swallowed. */
    .canvas-tool-hand iframe,
    .canvas-tool-hand webview,
    .canvas-tool-hand .monaco-editor,
    .canvas-tool-hand .xterm,
    .canvas-tool-hand .xterm-screen,
    .canvas-tool-hand .xterm-helper-textarea {
      pointer-events: none !important;
      cursor: grab !important;
    }
    /* Hand tool active: the whole node is inert. Only the grab cursor shows
       (no resize/"scale", text, or button cursors), and every left-press falls
       through to the node container -> canvas pan handler. Panel content, chrome
       buttons, and resize strips stop intercepting events, so nothing is
       clickable in this mode. */
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
    /* Regions get the same treatment: grab cursor only, and the label + resize
       brackets stop intercepting so a press on a region pans the canvas. The
       region body itself keeps pointer-events so its bail-to-pan handler runs. */
    .canvas-tool-hand [data-region-id],
    .canvas-tool-hand [data-region-id] *,
    .canvas-tool-hand [data-region-resize-handle] {
      cursor: grab !important;
    }
    .canvas-tool-hand [data-region-id] *,
    .canvas-tool-hand [data-region-resize-handle] {
      pointer-events: none !important;
    }
    /* During an active hand-pan, show the closed-hand (grabbing) cursor over
       nodes too, matching the canvas background. */
    .canvas-interacting.canvas-tool-hand [data-node-id],
    .canvas-interacting.canvas-tool-hand [data-node-id] *,
    .canvas-interacting.canvas-tool-hand [data-resize-frame-for],
    .canvas-interacting.canvas-tool-hand [data-resize-frame-for] *,
    .canvas-interacting.canvas-tool-hand [data-region-id],
    .canvas-interacting.canvas-tool-hand [data-region-id] *,
    .canvas-interacting.canvas-tool-hand [data-region-resize-handle] {
      cursor: grabbing !important;
    }
  `
  document.head.appendChild(style)
}

const RegionsLayer: React.FC = React.memo(() => {
  const zoomLevel = useCanvasStoreContext((s) => s.zoomLevel)
  const regionList = useCanvasStoreContext(
    (s) => Object.values(s.regions),
    shallow,
  )
  return (
    <>
      {regionList.map((region) => (
        <CanvasRegionComponent key={region.id} region={region} zoomLevel={zoomLevel} />
      ))}
    </>
  )
})

interface CanvasProps {
  children?: React.ReactNode
  /** Called when the user right-clicks empty canvas and picks a panel type. */
  onCreateAtPoint?: (type: PanelType, canvasPoint: Point) => void
  /** Stamped onto the container so resolveDrop can map back to a CanvasStore. */
  panelId?: string
}

const Canvas: React.FC<CanvasProps> = ({ children, onCreateAtPoint, panelId }) => {
  const canvasRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const canvasApi = useCanvasStoreApi()
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })

  const marquee = useUIStore((s) => s.marquee)
  // Idle cursor reflects the active tool (React owns idle; useCanvasInteraction
  // overrides to 'grabbing' during an active pan and hands control back on release).
  const handToolActive = useUIStore((s) => effectiveCanvasTool(s) === 'hand')
  const idleCursor = handToolActive ? 'grab' : 'default'

  // While the Hand tool is active, neutralize interactive panel content so a
  // left-press anywhere pans the canvas (see the .canvas-tool-hand CSS rules).
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
  } = useCanvasInteraction(canvasRef, canvasApi)

  // Inject the canvas-interacting style once at module level (not per mount)
  useEffect(injectCanvasInteractingStyle, [])

  // Imperatively update the world div transform on zoom/offset changes so
  // Canvas itself never re-renders during pan/zoom — only the world div moves.
  useEffect(() => {
    const applyTransform = (zoom: number, offset: { x: number; y: number }) => {
      const el = worldRef.current
      if (!el) return
      el.style.transform = `scale(${zoom}) translate(${offset.x / zoom}px, ${offset.y / zoom}px)`
      el.style.setProperty('--zoom', String(zoom))
    }

    // Apply current state immediately on mount
    const { zoomLevel, viewportOffset } = canvasApi.getState()
    applyTransform(zoomLevel, viewportOffset)

    // Subscribe to future changes
    const unsubscribe = canvasApi.subscribe((state, prev) => {
      if (state.zoomLevel !== prev.zoomLevel || state.viewportOffset !== prev.viewportOffset) {
        applyTransform(state.zoomLevel, state.viewportOffset)
      }
    })
    return unsubscribe
  }, []) // mount-only

  // Auto-focus the node that occupies the most visible viewport area (opt-in).
  useAutoFocusLargestVisible(canvasApi)

  // NOTE: the canvas is intentionally NOT registered in the dock drop-zone
  // registry. `resolveDrop` handles canvas drops via `data-canvas-container`
  // attribute hit-testing (creating a new canvas node at the cursor);
  // registering it here would mis-route drops to the center dock zone.

  // Register wheel listener with { passive: false } so preventDefault works
  // React's onWheel is passive by default, which silently ignores preventDefault
  const handleWheelRef = useRef(handleWheel)
  handleWheelRef.current = handleWheel

  useEffect(() => {
    const el = canvasRef.current
    if (!el) return

    const onWheel = (e: WheelEvent) => {
      handleWheelRef.current(e as unknown as React.WheelEvent<HTMLDivElement>)
    }

    el.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => el.removeEventListener('wheel', onWheel, { capture: true })
  }, []) // mount-only — no dependency on handleWheel

  // Track container size for grid visibility calculations
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const size = {
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        }
        setContainerSize(size)
        canvasApi.getState().setContainerSize(size)
      }
    })

    observer.observe(el)
    const initialSize = {
      width: el.clientWidth,
      height: el.clientHeight,
    }
    setContainerSize(initialSize)
    canvasApi.getState().setContainerSize(initialSize)

    return () => observer.disconnect()
  }, [])

  // Click on the canvas background (world div) to unfocus
  const handleWorldClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Only unfocus if clicking directly on the world div, not on a child node
      const target = e.target as HTMLElement
      if (!target.closest('[data-node-id]') && !target.closest('[data-region-id]')) {
        canvasApi.getState().unfocus()
      }
    },
    [],
  )

  const handleFileDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // Accept internal drag (file explorer) and OS-level file/folder drops.
    if (
      e.dataTransfer.types.includes('application/cate-file') ||
      e.dataTransfer.types.includes('application/cate-spawn') ||
      e.dataTransfer.types.includes('Files')
    ) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }, [])

  const handleFileDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    // Spawn drop from the Parallel Work tab — drop a terminal/agent for a
    // worktree at the exact cursor position, tagged with the worktree id.
    const spawnData = e.dataTransfer.getData('application/cate-spawn')
    if (spawnData) {
      e.preventDefault()
      let spec: { panelType?: 'terminal' | 'agent'; cwd?: string; worktreeId?: string } = {}
      try { spec = JSON.parse(spawnData) } catch { return }
      if (spec.panelType !== 'terminal' && spec.panelType !== 'agent') return
      const rect = canvasRef.current?.getBoundingClientRect()
      if (!rect) return
      const viewPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top }
      const { zoomLevel, viewportOffset } = canvasApi.getState()
      const pos = viewToCanvas(viewPoint, zoomLevel, viewportOffset)
      const wsId = useAppStore.getState().selectedWorkspaceId
      const store = useAppStore.getState()
      const panelId =
        spec.panelType === 'terminal'
          ? store.createTerminal(wsId, undefined, pos, undefined, spec.cwd)
          : store.createAgent(wsId, pos)
      if (panelId && spec.worktreeId) {
        store.setPanelWorktreeId(wsId, panelId, spec.worktreeId)
      }
      return
    }

    // Support internal multi-file drops…
    const multiData = e.dataTransfer.getData('application/cate-files')
    const singlePath = e.dataTransfer.getData('application/cate-file')
    let filePaths: string[] = []
    if (multiData) {
      try { filePaths = JSON.parse(multiData) } catch { /* ignore */ }
    }
    if (filePaths.length === 0 && singlePath) {
      filePaths = [singlePath]
    }
    // …and OS-level drops from Finder / Explorer (Electron exposes `path`).
    if (filePaths.length === 0 && e.dataTransfer.files.length > 0) {
      for (const f of Array.from(e.dataTransfer.files)) {
        const p = (f as any).path as string | undefined
        if (p) filePaths.push(p)
      }
    }
    if (filePaths.length === 0) return

    e.preventDefault()
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const viewPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    const { zoomLevel, viewportOffset } = canvasApi.getState()
    const canvasPoint = viewToCanvas(viewPoint, zoomLevel, viewportOffset)
    const wsId = useAppStore.getState().selectedWorkspaceId

    let offsetX = 0
    for (const filePath of filePaths) {
      let isDir = false
      try {
        const stat = await window.electronAPI.fsStat(filePath)
        isDir = !!stat?.isDirectory
      } catch { /* fall through; treat as file */ }
      const pos = { x: canvasPoint.x + offsetX, y: canvasPoint.y }
      if (isDir) {
        // Drop of a folder → spawn a terminal scoped to that path.
        useAppStore.getState().createTerminal(wsId, undefined, pos, undefined, filePath)
      } else {
        openFileAsPanel(wsId, filePath, pos)
      }
      offsetX += 40
    }
  }, [canvasRef])

  // Memoize marquee rect to avoid recalculation in render
  const marqueeRect = useMemo(() => {
    if (!marquee) return null
    return {
      x: Math.min(marquee.startX, marquee.currentX),
      y: Math.min(marquee.startY, marquee.currentY),
      w: Math.abs(marquee.currentX - marquee.startX),
      h: Math.abs(marquee.currentY - marquee.startY),
    }
  }, [marquee])

  // When the interaction hook flags a right-click on empty canvas, fire a
  // native context menu and dispatch the picked action.
  useEffect(() => {
    if (!canvasContextMenu || !window.electronAPI) return
    let cancelled = false
    const point = canvasContextMenu.canvasPoint
    const wsId = useAppStore.getState().selectedWorkspaceId
    const ws = useAppStore.getState().workspaces.find((w) => w.id === wsId)
    const rootPath = ws?.rootPath

    // Fetch live worktree list from git so deleted ones never appear.
    const buildAndShow = async () => {
      let gitWorktrees: Array<{ path: string; branch: string; isCurrent: boolean }> = []
      if (rootPath) {
        try {
          gitWorktrees = await window.electronAPI.gitWorktreeList(rootPath)
        } catch { /* single-root fallback */ }
      }

      const items: Array<any> = []
      if (onCreateAtPoint) {
        if (gitWorktrees.length > 1) {
          items.push({
            label: 'New Terminal',
            submenu: gitWorktrees.map((g) => ({
              id: `new-terminal:${g.path}`,
              label: (g.branch || (g.isCurrent ? 'main' : '(detached)')) + (g.isCurrent ? ' (primary)' : ''),
            })),
          })
        } else {
          items.push({ id: 'new-terminal', label: 'New Terminal' })
        }
        items.push(
          { id: 'new-editor', label: 'New Editor' },
          { id: 'new-browser', label: 'New Browser' },
          { id: 'new-agent', label: 'New Pi Agent' },
          { id: 'new-canvas', label: 'New Canvas' },
          { type: 'separator' as const },
        )
      }
      items.push(
        { id: 'new-region', label: 'New Region' },
      )
      const id = await window.electronAPI.showContextMenu(items)
      if (cancelled) return
      closeCanvasContextMenu()
      if (id?.startsWith('new-terminal:')) {
        const wtPath = id.slice('new-terminal:'.length)
        const g = gitWorktrees.find((w) => w.path === wtPath)
        if (g) {
          const cwdToUse = g.isCurrent ? undefined : g.path
          const panelId = useAppStore.getState().createTerminal(wsId, undefined, point, undefined, cwdToUse)
          const storedWt = (useAppStore.getState().workspaces.find((w) => w.id === wsId)?.worktrees ?? [])
            .find((w) => w.path === g.path)
          if (storedWt) {
            useAppStore.getState().setPanelWorktreeId(wsId, panelId, storedWt.id)
          }
        }
        return
      }
      // If the click point falls inside a Region that has a defaultCwd,
      // a "New Terminal" inherits that cwd. Editors/browsers don't.
      const regions = Object.values(canvasApi.getState().regions)
      const containingRegion = regions.find(
        (r) =>
          point.x >= r.origin.x &&
          point.x <= r.origin.x + r.size.width &&
          point.y >= r.origin.y &&
          point.y <= r.origin.y + r.size.height,
      )
      switch (id) {
        case 'new-terminal':
          if (containingRegion?.defaultCwd) {
            useAppStore.getState().createTerminal(wsId, undefined, point, undefined, containingRegion.defaultCwd)
          } else {
            onCreateAtPoint?.('terminal', point)
          }
          break
        case 'new-editor': onCreateAtPoint?.('editor', point); break
        case 'new-browser': onCreateAtPoint?.('browser', point); break
        case 'new-agent': onCreateAtPoint?.('agent', point); break
        case 'new-canvas': onCreateAtPoint?.('canvas', point); break
        case 'new-region':
          canvasApi.getState().addRegion('Region', point, { width: 400, height: 300 })
          break
      }
    }
    void buildAndShow()
    return () => { cancelled = true }
  }, [canvasContextMenu, onCreateAtPoint, canvasApi, closeCanvasContextMenu])

  return (
    <div
      ref={canvasRef}
      data-canvas-container
      data-canvas-panel-id={panelId}
      className="relative w-full h-full overflow-hidden bg-canvas-bg"
      style={{ cursor: idleCursor }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onContextMenu={handleContextMenu}
      onDragOver={handleFileDragOver}
      onDrop={handleFileDrop}
    >
      {/* Grid renders in screen-space (outside the world transform) so lines
          land on whole device pixels at every zoom level. */}
      <CanvasGrid
        containerWidth={containerSize.width}
        containerHeight={containerSize.height}
      />

      {/* World div: transformed to implement pan/zoom */}
      <div
        ref={worldRef}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: 1,
          height: 1,
          transformOrigin: '0 0',
          willChange: 'transform',
        }}
        onClick={handleWorldClick}
      >
        <RegionsLayer />
        <SnapGuides />
        {marqueeRect && (
          <div
            style={{
              position: 'absolute',
              left: marqueeRect.x,
              top: marqueeRect.y,
              width: marqueeRect.w,
              height: marqueeRect.h,
              backgroundColor: 'rgba(74, 158, 255, 0.1)',
              border: '1px solid rgba(74, 158, 255, 0.5)',
              borderRadius: 2,
              pointerEvents: 'none',
              zIndex: 99999,
            }}
          />
        )}
        {children}
      </div>

    </div>
  )
}

export default Canvas
