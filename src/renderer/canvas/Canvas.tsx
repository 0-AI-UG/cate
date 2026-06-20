// =============================================================================
// Canvas — the main infinite canvas component.
// Ported from CanvasView.swift.
// =============================================================================

import React, { useRef, useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useCanvasStoreContext, useCanvasStoreApi } from '../stores/CanvasStoreContext'
import { useAppStore, type PanelPlacement } from '../stores/appStore'
import { useCanvasInteraction } from '../hooks/useCanvasInteraction'
import { useAutoFocusLargestVisible } from '../hooks/useAutoFocusLargestVisible'
import { useUIStore } from '../stores/uiStore'
import { useSettingsStore } from '../stores/settingsStore'
import { canvasToView, viewToCanvas } from '../lib/canvas/coordinates'
import CanvasGrid from './CanvasGrid'
import CanvasBackgroundImage from './CanvasBackgroundImage'
import SnapGuides from './SnapGuides'
import GhostPlacementLayer from './GhostPlacementLayer'
import PlacementVizOverlay from './placementViz/PlacementVizOverlay'
import { WorktreeTerritoryLayer } from './worktree'
import type { Point, PanelType } from '../../shared/types'
import { openFileAsPanel } from '../lib/fs/fileRouting'
import { setPendingReveal } from '../lib/editor/editorReveal'

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
    /* During an active hand-pan, show the closed-hand (grabbing) cursor over
       nodes too, matching the canvas background. */
    .canvas-interacting.canvas-tool-hand [data-node-id],
    .canvas-interacting.canvas-tool-hand [data-node-id] *,
    .canvas-interacting.canvas-tool-hand [data-resize-frame-for],
    .canvas-interacting.canvas-tool-hand [data-resize-frame-for] * {
      cursor: grabbing !important;
    }
  `
  document.head.appendChild(style)
}

// A small instruction pill for the placement picker, centred over the visible
// canvas (the strip between the absolute-overlay sidebars). Body-portalled so it
// floats above app chrome. No dimming/blocking — the app stays interactive.
const Kbd: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <kbd style={{
    display: 'inline-block', minWidth: 18, padding: '1px 5px', margin: '0 1px',
    borderRadius: 5, background: 'var(--surface-4)', color: 'var(--text-primary)',
    border: '1px solid var(--border-strong)', borderBottomWidth: 2,
    fontSize: 11, fontWeight: 600, textAlign: 'center', lineHeight: '16px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  }}>{children}</kbd>
)

const PlacementHint: React.FC<{ canvasRef: React.RefObject<HTMLDivElement> }> = ({ canvasRef }) => {
  const pending = useCanvasStoreContext((s) => s.pendingPlacement)
  const api = useCanvasStoreApi()
  if (!pending) return null
  const r = canvasRef.current?.getBoundingClientRect()
  if (!r) return null
  // The sidebars now push the canvas rather than overlaying it, so the canvas
  // rect itself is the visible region.
  const visLeft = r.left
  const visRight = r.right
  const count = pending.candidates.length
  const armed = pending.freeArmed

  return createPortal(
    <>
      {/* Hint pill centred on the visible canvas (matching the bottom toolbar). */}
      <div style={{
        position: 'fixed', left: (visLeft + visRight) / 2, top: r.top + 16, transform: 'translateX(-50%)',
        zIndex: 2147483000, display: 'flex', alignItems: 'center', gap: 14,
        padding: '9px 9px 9px 16px', borderRadius: 999,
        // Match the bottom toolbar so the bar adapts to the active theme.
        background: 'var(--surface-0)', border: '1px solid var(--border-subtle)',
        boxShadow: '0 8px 24px -6px var(--shadow-node)', color: 'var(--text-primary)',
        fontSize: 13, fontWeight: 500, fontFamily: 'system-ui, -apple-system, sans-serif',
        animation: 'ghostHintIn 200ms ease both', userSelect: 'none', whiteSpace: 'nowrap',
      }}>
        <span>
          {armed ? (
            <>Click anywhere to place. <Kbd>F</Kbd> to go back.</>
          ) : (
            <>Pick a spot. Press <Kbd>1</Kbd>{count > 1 ? <>–<Kbd>{count}</Kbd></> : null}, click a ghost, or <Kbd>F</Kbd> to place anywhere.</>
          )}
        </span>
        <button
          onClick={() => api.getState().cancelPlacement()}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 999,
            border: 'none', cursor: 'pointer', background: 'var(--surface-hover-strong)',
            color: 'var(--text-secondary)', fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
          }}
        >
          Cancel <Kbd>Esc</Kbd>
        </button>
      </div>
    </>,
    document.body,
  )
}

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
  // Debounce handle for de-promoting the world layer after pan/zoom settles.
  const willChangeResetRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const canvasApi = useCanvasStoreApi()
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })

  // Pin positioned creates (drops, right-click "new here") to THIS canvas so the
  // node lands where the user aimed rather than on the workspace's primary
  // canvas. Undefined for a context-less canvas → falls back to primary routing.
  const here = useCallback(
    (): PanelPlacement | undefined => (panelId ? { target: 'canvas', canvasPanelId: panelId } : undefined),
    [panelId],
  )

  const marquee = useUIStore((s) => s.marquee)
  // Idle cursor reflects the active tool (React owns idle; useCanvasInteraction
  // overrides to 'grabbing' during an active pan and hands control back on release).
  const handToolActive = useUIStore((s) => s.activeTool === 'hand')
  const idleCursor = handToolActive ? 'grab' : 'default'
  const showWorktreeTerritory = useSettingsStore((s) => s.showWorktreeTerritory)

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

      // Promote the world to its own GPU layer for the duration of the gesture so
      // pan/zoom stays smooth, then de-promote once it settles. While promoted,
      // Chromium bitmap-scales the layer's cached texture (blurs thin SVG icon
      // strokes); removing will-change forces a crisp re-raster at the resting
      // transform. Debounced so it only fires after the user stops interacting.
      el.style.willChange = 'transform'
      if (willChangeResetRef.current) clearTimeout(willChangeResetRef.current)
      willChangeResetRef.current = setTimeout(() => {
        const node = worldRef.current
        if (node) node.style.willChange = 'auto'
        willChangeResetRef.current = null
      }, 150)
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
    return () => {
      unsubscribe()
      if (willChangeResetRef.current) clearTimeout(willChangeResetRef.current)
    }
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

  // Track the canvas-space pointer so ghost-placement recommendations can be
  // anchored to where the mouse is hovering. rAF-throttled; the store setter is
  // non-reactive so this never triggers a re-render.
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    let pending: { clientX: number; clientY: number } | null = null
    let rafId = 0
    const flush = () => {
      rafId = 0
      if (!pending) return
      const rect = el.getBoundingClientRect()
      const { zoomLevel, viewportOffset } = canvasApi.getState()
      const canvasPt = viewToCanvas(
        { x: pending.clientX - rect.left, y: pending.clientY - rect.top },
        zoomLevel,
        viewportOffset,
      )
      canvasApi.getState().setPlacementPointer(canvasPt)
    }
    const onMove = (e: MouseEvent) => {
      pending = { clientX: e.clientX, clientY: e.clientY }
      if (!rafId) rafId = requestAnimationFrame(flush)
    }
    el.addEventListener('mousemove', onMove)
    return () => {
      el.removeEventListener('mousemove', onMove)
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [])

  // Track container size for grid visibility, and keep canvas content anchored
  // to whichever container edge stayed put when the OTHER edge moves — so a
  // sidebar (or dock split) opening pushes content by its full width instead of
  // letting it slide under the newly covered edge.
  //
  // One symmetric rule, no knowledge of sidebars: the world transform is
  // anchored to the container's top-left, so a moving LEFT edge already drags
  // content along; we only need to add the RIGHT edge's movement when the left
  // edge held still (the right sidebar / a split divider). A window resize moves
  // the right edge too but should NOT chase content, so we gate on the window
  // width being unchanged. Pure translations don't change size and never fire.
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return

    let prevRect = el.getBoundingClientRect()
    let prevWindowWidth = window.innerWidth

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const size = {
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        }
        setContainerSize(size)
        canvasApi.getState().setContainerSize(size)
      }
      const rect = el.getBoundingClientRect()
      const windowResized = window.innerWidth !== prevWindowWidth
      const dLeft = rect.left - prevRect.left
      const dRight = rect.right - prevRect.right
      prevRect = rect
      prevWindowWidth = window.innerWidth
      if (!windowResized && Math.abs(dLeft) < 0.5 && Math.abs(dRight) > 0.5) {
        const { viewportOffset } = canvasApi.getState()
        canvasApi.setState({ viewportOffset: { x: viewportOffset.x + dRight, y: viewportOffset.y } })
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
      const target = e.target as HTMLElement
      // A click that misses every ghost cancels a pending ghost placement.
      // (Ghosts stopPropagation on their own clicks, so this only fires on a miss.)
      if (canvasApi.getState().pendingPlacement) {
        if (!target.closest('[data-ghost-candidate]')) {
          canvasApi.getState().cancelPlacement()
        }
        return
      }
      // Only unfocus if clicking directly on the world div, not on a child node
      if (!target.closest('[data-node-id]')) {
        canvasApi.getState().unfocus()
        // A click on empty canvas also dismisses the worktree focus lens.
        useUIStore.getState().clearWorktreeLens()
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
          ? store.createTerminal(wsId, undefined, pos, here(), spec.cwd)
          : store.createAgent(wsId, pos, here())
      if (panelId && spec.worktreeId) {
        store.setPanelWorktreeId(wsId, panelId, spec.worktreeId)
      }
      return
    }

    // Support internal multi-file drops…
    const multiData = e.dataTransfer.getData('application/cate-files')
    const singlePath = e.dataTransfer.getData('application/cate-file')
    // Optional open-at-line payload (dragging a specific search-result line).
    let lineReveal: { path: string; line: number; column?: number } | null = null
    const lineRaw = e.dataTransfer.getData('application/cate-file-line')
    if (lineRaw) {
      try { lineReveal = JSON.parse(lineRaw) } catch { /* ignore */ }
    }
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
    e.stopPropagation()
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
        const stat = await window.electronAPI.fsStat(filePath, wsId)
        isDir = !!stat?.isDirectory
      } catch { /* fall through; treat as file */ }
      const pos = { x: canvasPoint.x + offsetX, y: canvasPoint.y }
      if (isDir) {
        // Drop of a folder → spawn a terminal scoped to that path.
        useAppStore.getState().createTerminal(wsId, undefined, pos, here(), filePath)
      } else {
        const panelId = openFileAsPanel(wsId, filePath, pos, here())
        if (panelId && lineReveal && lineReveal.path === filePath) {
          setPendingReveal(panelId, { line: lineReveal.line, column: lineReveal.column })
        }
      }
      offsetX += 40
    }
  }, [canvasRef, here])

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
          { id: 'new-agent', label: 'New Cate agent' },
          { id: 'new-canvas', label: 'New Canvas' },
          { type: 'separator' as const },
        )
      }
      items.push(
        { id: 'auto-layout', label: 'Auto Layout' },
        { id: 'zoom-to-fit', label: 'Zoom to Fit' },
      )
      const id = await window.electronAPI.showContextMenu(items)
      if (cancelled) return
      closeCanvasContextMenu()
      if (id?.startsWith('new-terminal:')) {
        const wtPath = id.slice('new-terminal:'.length)
        const g = gitWorktrees.find((w) => w.path === wtPath)
        if (g) {
          const cwdToUse = g.isCurrent ? undefined : g.path
          const panelId = useAppStore.getState().createTerminal(wsId, undefined, point, here(), cwdToUse)
          const storedWt = (useAppStore.getState().workspaces.find((w) => w.id === wsId)?.worktrees ?? [])
            .find((w) => w.path === g.path)
          if (storedWt) {
            useAppStore.getState().setPanelWorktreeId(wsId, panelId, storedWt.id)
          }
        }
        return
      }
      switch (id) {
        case 'new-terminal':
          onCreateAtPoint?.('terminal', point)
          break
        case 'new-editor': onCreateAtPoint?.('editor', point); break
        case 'new-browser': onCreateAtPoint?.('browser', point); break
        case 'new-agent': onCreateAtPoint?.('agent', point); break
        case 'new-canvas': onCreateAtPoint?.('canvas', point); break
        case 'auto-layout':
          canvasApi.getState().autoLayout()
          break
        case 'zoom-to-fit':
          canvasApi.getState().zoomToFit()
          break
      }
    }
    void buildAndShow()
    return () => { cancelled = true }
  }, [canvasContextMenu, onCreateAtPoint, canvasApi, closeCanvasContextMenu, here])

  return (
    <div
      ref={canvasRef}
      data-canvas-container
      data-canvas-panel-id={panelId}
      data-filedrop="canvas"
      data-filedrop-id={panelId}
      // overflow-clip, not overflow-hidden: the canvas pans via the world
      // transform and must never become a scroll container. `hidden` clips
      // visually but still allows *programmatic* scrolling — when a panel's
      // content overflows the viewport (e.g. an xterm helper-textarea/cursor at
      // the far right when typing to the end of a line), the browser auto-scrolls
      // it into view, shifting the grid + wallpaper left and exposing a blank
      // bg-canvas-bg strip on the right. `clip` is not a scroll container, so
      // focus/scrollIntoView can't move it.
      className="relative w-full h-full overflow-clip bg-canvas-bg"
      style={{ cursor: idleCursor }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onContextMenu={handleContextMenu}
      onDragOver={handleFileDragOver}
      onDrop={handleFileDrop}
    >
      {/* Optional wallpaper, behind the grid and panels. Rendered before the
          grid so the grid (same z-index) paints on top of it. */}
      <CanvasBackgroundImage />

      {/* Grid renders in screen-space (outside the world transform) so lines
          land on whole device pixels at every zoom level. */}
      <CanvasGrid
        containerWidth={containerSize.width}
        containerHeight={containerSize.height}
      />

      {/* Worktree territory — colours the grid dots per worktree. Screen-space
          (outside the world transform), above the grid, behind all panels.
          Opt-out via Settings → Canvas → Worktree territories. */}
      {showWorktreeTerritory && (
        <WorktreeTerritoryLayer
          containerWidth={containerSize.width}
          containerHeight={containerSize.height}
        />
      )}

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
          // will-change is toggled imperatively during pan/zoom (see applyTransform)
          // so the layer de-promotes at rest and re-rasters icons crisply.
        }}
        onClick={handleWorldClick}
      >
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
        <GhostPlacementLayer />
        {(import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV && <PlacementVizOverlay />}
      </div>

      <PlacementHint canvasRef={canvasRef} />
    </div>
  )
}

export default Canvas
