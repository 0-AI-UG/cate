// =============================================================================
// CanvasDropZone — full-area drop target shown over a canvas while a panel
// or canvas-node is being dragged. The dragged item appears as a window-
// shaped ghost following the cursor; releasing drops the new node at that
// position. Also handles cross-canvas moves and dock→canvas detach.
// =============================================================================

import { useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import type { StoreApi } from 'zustand'
import type { CanvasStore } from '../stores/canvasStore'
import { findCanvasStoreForNode } from '../stores/canvasStore'
import { useDockDragStore } from '../hooks/useDockDrag'
import { useDockStore } from '../stores/dockStore'
import { findNodeIdForDockStore } from '../panels/CanvasPanel'
import type { PanelType } from '../../shared/types'
import { PANEL_DEFAULT_SIZES } from '../../shared/types'

/**
 * When true, drag handlers should skip setting activeDropTarget because
 * the CanvasDropZone overlay is handling the drop. Module-level so the hot
 * mousemove path can check it synchronously without a store subscription.
 */
export let canvasDropZoneHovered = false

interface CanvasDropZoneProps {
  canvasStoreApi: StoreApi<CanvasStore>
}

const PANEL_TYPE_LABELS: Record<PanelType, string> = {
  editor: 'Editor',
  terminal: 'Terminal',
  browser: 'Browser',
  git: 'Git',
  fileExplorer: 'File Explorer',
  projectList: 'Projects',
  canvas: 'Canvas',
}

export default function CanvasDropZone({ canvasStoreApi }: CanvasDropZoneProps) {
  const isDragging = useDockDragStore((s) => s.isDragging)
  const dragSource = useDockDragStore((s) => s.dragSource)
  const draggedPanelType = useDockDragStore((s) => s.draggedPanelType)

  // Show for any active drag (dock or canvas source), but never for canvas
  // panels themselves — nesting a canvas inside a canvas isn't supported.
  if (!isDragging || !dragSource) return null
  if (draggedPanelType === 'canvas') return null

  return <CanvasDropZoneInner canvasStoreApi={canvasStoreApi} />
}

/** Outer strip (in px) along each canvas edge that the canvas overlay does
 *  NOT claim as a drop target. When the cursor is inside this strip the
 *  canvas drop yields to the underlying dock-zone drop indicators (left /
 *  right / bottom edge of the window), so the user can still dock a panel
 *  into a hidden side zone by dragging to the edge. Matches the 60 px width
 *  used by MainWindowShell's DockZoneDropIndicator slots. */
const EDGE_STRIP = 60

function CanvasDropZoneInner({ canvasStoreApi }: CanvasDropZoneProps) {
  const overlayRef = useRef<HTMLDivElement>(null)
  const pillRef = useRef<HTMLDivElement>(null)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  const [inCenter, setInCenter] = useState(false)
  // Mirror `inCenter` in a ref so the pointerUp handler reads the freshest
  // value — React state may not have committed the last setInCenter from the
  // preceding pointerMove before the release event fires.
  const inCenterRef = useRef(false)
  const draggedPanelType = useDockDragStore((s) => s.draggedPanelType)
  const draggedPanelTitle = useDockDragStore((s) => s.draggedPanelTitle)
  const dragSource = useDockDragStore((s) => s.dragSource)
  const grabOffsetCanvas = useDockDragStore((s) => s.dragGrabOffset)
  const dockSourceSize = useDockDragStore((s) => s.dragSourceSize)
  const dragSourceNodeSize = useDockDragStore((s) => s.dragSourceNodeSize)
  // Subscribe reactively so the ghost rescales live when the user zooms the
  // target canvas mid-drag. Previously this was a one-shot getState().
  const targetZoom = useStore(canvasStoreApi, (s) => s.zoomLevel)
  // ---- Unified source-size resolution ---------------------------------
  // sourceSize is the canvas-space size the dropped/moved node will have.
  // The ghost is rendered at sourceSize × targetZoom, and the dropped node
  // is also sized to sourceSize, so what you see is what you get.
  // Priority:
  //   1. canvas source → the actual node's current size (real)
  //   2. dock source backed by a canvas node → that node's size (mini-dock,
  //      real — preserves a tab dragged out of a canvas-node back onto canvas)
  //   3. fallback → PANEL_DEFAULT_SIZES — used for tabs coming from the main
  //      dock (no canvas counterpart). The user expects these to land at a
  //      sensible default size, not at the (often huge) dock-panel rect.
  let sourceSize =
    (draggedPanelType && PANEL_DEFAULT_SIZES[draggedPanelType]) ??
    { width: 600, height: 400 }
  if (dragSource?.type === 'canvas') {
    const sourceCanvas = findCanvasStoreForNode(dragSource.nodeId)
    const srcNode = sourceCanvas?.getState().nodes[dragSource.nodeId]
    if (srcNode) sourceSize = { width: srcNode.size.width, height: srcNode.size.height }
  } else if (dragSourceNodeSize) {
    sourceSize = dragSourceNodeSize
  }

  // Ghost is rendered in screen-space (px), scaled to match the target zoom.
  const ghostPxSize = { width: sourceSize.width * targetZoom, height: sourceSize.height * targetZoom }
  // Cursor → ghost-top-left offset, also in screen-px. Anchor the cursor at
  // the same relative point inside the ghost that the user grabbed. The grab
  // offset is in screen pixels (relative to the source's on-screen rect), so
  // we proportionally remap it to the ghost's screen-px size.
  let ghostOffset: { x: number; y: number } = { x: ghostPxSize.width / 2, y: ghostPxSize.height / 2 }
  if (grabOffsetCanvas) {
    if (dragSource?.type === 'canvas') {
      // grab offset is in canvas-space here (set by useNodeDrag)
      ghostOffset = { x: grabOffsetCanvas.x * targetZoom, y: grabOffsetCanvas.y * targetZoom }
    } else if (dockSourceSize) {
      ghostOffset = {
        x: (grabOffsetCanvas.x / dockSourceSize.width) * ghostPxSize.width,
        y: (grabOffsetCanvas.y / dockSourceSize.height) * ghostPxSize.height,
      }
    }
  }
  const defaults = ghostPxSize

  // Reset the module-level flag on unmount — onPointerLeave won't fire if
  // the component unmounts while hovered (e.g. when endDrag() is called).
  useEffect(() => {
    return () => {
      canvasDropZoneHovered = false
    }
  }, [])

  const updateCursor = (clientX: number, clientY: number, rect: DOMRect) => {
    const x = clientX - rect.left
    const y = clientY - rect.top
    const inOverlay = x >= 0 && y >= 0 && x <= rect.width && y <= rect.height
    // Yield to the dock-zone drop indicators (left/right/bottom edges of the
    // window) when the cursor sits in the outer edge strip. Without this,
    // CanvasDropZone claims the whole canvas area and the underlying dock
    // indicators never fire — so the user can't dock a panel into a hidden
    // side zone by dragging to the edge anymore.
    const inEdgeStrip = inOverlay && (
      x < EDGE_STRIP ||
      y < EDGE_STRIP ||
      x > rect.width - EDGE_STRIP ||
      y > rect.height - EDGE_STRIP
    )
    const center = inOverlay && !inEdgeStrip
    setCursor({ x, y })
    setInCenter(center)
    inCenterRef.current = center
    canvasDropZoneHovered = center
    if (center) {
      useDockDragStore.getState().setDropTarget(null)
    }
  }

  return (
    <div
      ref={overlayRef}
      onPointerEnter={(e) => {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
        updateCursor(e.clientX, e.clientY, rect)
      }}
      onPointerMove={(e) => {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
        updateCursor(e.clientX, e.clientY, rect)
      }}
      onPointerLeave={() => {
        canvasDropZoneHovered = false
        inCenterRef.current = false
        setCursor(null)
        setInCenter(false)
      }}
      onPointerUp={(e) => {
        // Re-compute cursor position right before deciding so the drop is
        // gated on the FINAL cursor location, not the last pointermove.
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
        updateCursor(e.clientX, e.clientY, rect)
        // Only handle drops that land in the center region — edge drops are
        // handled by the dock's normal split-target executeDrop path.
        if (!inCenterRef.current) return

        const dragState = useDockDragStore.getState()
        const { draggedPanelId, draggedPanelType, dragSource, sourceDockStoreApi } = dragState
        if (!draggedPanelId || !draggedPanelType) return

        // Mark consumed BEFORE removing from source so the source's own
        // mouseup handler bails out instead of duplicating the drop.
        useDockDragStore.getState().markCanvasDropConsumed()

        // Canvas-node mini-dock source — the user dragged the (only) tab of
        // a canvas node back onto the same canvas. Treat as a reposition of
        // the existing node instead of undock+add, which would leave an empty
        // canvas node behind and spawn a duplicate.
        if (dragSource?.type === 'dock' && sourceDockStoreApi) {
          const ownedNodeId = findNodeIdForDockStore(sourceDockStoreApi)
          if (ownedNodeId && canvasStoreApi.getState().nodes[ownedNodeId]) {
            const sourceCs = canvasStoreApi.getState()
            const localX = e.clientX - rect.left
            const localY = e.clientY - rect.top
            const zoom = sourceCs.zoomLevel
            const vp = sourceCs.viewportOffset
            const canvasX = (localX - vp.x) / zoom
            const canvasY = (localY - vp.y) / zoom
            const ownedNode = sourceCs.nodes[ownedNodeId]
            // Map grab offset (screen-px inside the source dock rect) into
            // canvas-space inside this node so the cursor lands at the same
            // relative point of the node after the move.
            let ox = ownedNode.size.width / 2
            let oy = ownedNode.size.height / 2
            if (grabOffsetCanvas && dockSourceSize) {
              ox = (grabOffsetCanvas.x / dockSourceSize.width) * ownedNode.size.width
              oy = (grabOffsetCanvas.y / dockSourceSize.height) * ownedNode.size.height
            }
            sourceCs.moveNode(ownedNodeId, { x: canvasX - ox, y: canvasY - oy })
            useDockDragStore.getState().endDrag()
            document.body.classList.remove('canvas-interacting')
            setCursor(null)
            setInCenter(false)
            return
          }
        }

        // --- Remove from source -----------------------------------------
        if (dragSource?.type === 'dock') {
          const sourceStore = sourceDockStoreApi ?? useDockStore
          sourceStore.getState().undockPanel(draggedPanelId)
        } else if (dragSource?.type === 'canvas') {
          // Self-drop onto the same canvas — reposition the existing node
          // at the cursor instead of bailing. The body-drag path moves the
          // node in real time, but a tab-initiated dock-drag never engages
          // useNodeDrag, so without this the node stayed in place even though
          // the user clearly meant to drop it at the cursor position.
          const sourceCs = canvasStoreApi.getState()
          if (sourceCs.nodes[dragSource.nodeId]) {
            const localX = e.clientX - rect.left
            const localY = e.clientY - rect.top
            const zoom = sourceCs.zoomLevel
            const vp = sourceCs.viewportOffset
            const canvasX = (localX - vp.x) / zoom
            const canvasY = (localY - vp.y) / zoom
            const ox = grabOffsetCanvas?.x ?? sourceCs.nodes[dragSource.nodeId].size.width / 2
            const oy = grabOffsetCanvas?.y ?? sourceCs.nodes[dragSource.nodeId].size.height / 2
            sourceCs.moveNode(dragSource.nodeId, { x: canvasX - ox, y: canvasY - oy })
            useDockDragStore.getState().endDrag()
            document.body.classList.remove('canvas-interacting')
            setCursor(null)
            setInCenter(false)
            return
          }
          const sourceCanvas = findCanvasStoreForNode(dragSource.nodeId)
          if (sourceCanvas) {
            sourceCanvas.getState().finalizeRemoveNode(dragSource.nodeId)
          }
        }

        // --- Add to this canvas at the cursor position ------------------
        const localX = e.clientX - rect.left
        const localY = e.clientY - rect.top
        const cs = canvasStoreApi.getState()
        const zoom = cs.zoomLevel
        const vp = cs.viewportOffset
        const canvasX = (localX - vp.x) / zoom
        const canvasY = (localY - vp.y) / zoom
        // Place the node's top-left so the cursor lands at the same relative
        // point inside the new node that the user grabbed in the source. For
        // canvas sources the grab offset is already in canvas-space; for dock
        // sources it's screen-px relative to the source rect and we rescale
        // proportionally to the new node's canvas-space size.
        let offsetX: number
        let offsetY: number
        if (dragSource?.type === 'canvas' && grabOffsetCanvas) {
          offsetX = grabOffsetCanvas.x
          offsetY = grabOffsetCanvas.y
        } else if (dragSource?.type === 'dock' && dockSourceSize && grabOffsetCanvas) {
          offsetX = (grabOffsetCanvas.x / dockSourceSize.width) * sourceSize.width
          offsetY = (grabOffsetCanvas.y / dockSourceSize.height) * sourceSize.height
        } else {
          offsetX = sourceSize.width / 2
          offsetY = sourceSize.height / 2
        }
        const position = {
          x: canvasX - offsetX,
          y: canvasY - offsetY,
        }
        const newNodeId = canvasStoreApi
          .getState()
          .addNode(draggedPanelId, draggedPanelType, position)
        // Resize the new node to match the ghost/source size so the drop
        // lands exactly where the preview showed it.
        canvasStoreApi.getState().resizeNode(newNodeId, {
          width: sourceSize.width,
          height: sourceSize.height,
        })
        // Focus the new node but DON'T pan the viewport — the user explicitly
        // dropped at this cursor position and expects it to stay there.
        canvasStoreApi.getState().focusNode(newNodeId)

        useDockDragStore.getState().endDrag()
        document.body.classList.remove('canvas-interacting')
        setCursor(null)
        setInCenter(false)
      }}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 9999,
        // Always capture pointer events so we can track the cursor over the
        // whole canvas and toggle center/edge — but we only CONSUME drops in
        // the center. Drops in the edge strip fall through because we don't
        // call executeDrop/markCanvasDropConsumed there, so the source's own
        // mouseup handler (which always runs on window-level listeners) picks
        // up the split-edge target that the dock's hit-test already resolved.
        pointerEvents: 'auto',
        cursor: inCenter ? 'copy' : 'default',
      }}
    >
      <style>{`
        @keyframes canvasDropZoneIn {
          from { opacity: 0; transform: translate(-50%, -50%) scale(0.92); }
          to   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        }
        @keyframes canvasDropPulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(74, 158, 255, 0.3); }
          50%      { box-shadow: 0 0 0 8px rgba(74, 158, 255, 0); }
        }
      `}</style>

      {/* Centered "Drop into canvas" pill — restored old look + pulse. */}
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'none',
          animation: 'canvasDropZoneIn 250ms cubic-bezier(0.16, 1, 0.3, 1)',
          zIndex: 1,
        }}
      >
        <div
          ref={pillRef}
          style={{
            position: 'relative',
            overflow: 'hidden',
            borderRadius: 20,
            background: inCenter ? 'rgba(74, 158, 255, 0.22)' : 'var(--surface-3)',
            border: inCenter
              ? '1px solid rgba(74, 158, 255, 0.9)'
              : `1px solid var(--border-subtle)`,
            boxShadow: inCenter
              ? '0 0 0 4px rgba(74, 158, 255, 0.18), 0 12px 32px -8px rgba(74, 158, 255, 0.5)'
              : 'none',
            backdropFilter: 'blur(12px)',
            padding: '10px 24px',
            minWidth: 200,
            textAlign: 'center',
            transition:
              'background 150ms ease, border-color 150ms ease, box-shadow 150ms ease, transform 200ms cubic-bezier(0.16, 1, 0.3, 1)',
            transform: inCenter ? 'scale(1.08)' : 'scale(1)',
            animation: inCenter ? 'canvasDropPulse 1.2s ease-in-out infinite' : 'none',
          }}
        >
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: inCenter ? 'var(--focus-blue)' : 'var(--text-secondary)',
              transition: 'color 150ms ease',
              whiteSpace: 'nowrap',
              userSelect: 'none',
            }}
          >
            Drop into canvas
          </span>
        </div>
      </div>

      {/* Window-shaped ghost following the cursor — previews where the new
          node will land. */}
      {cursor && (() => {
        const ghostLeft = cursor.x - ghostOffset.x
        const ghostTop = cursor.y - ghostOffset.y
        return (
        <div
          style={{
            position: 'absolute',
            left: ghostLeft,
            top: ghostTop,
            width: defaults.width,
            height: defaults.height,
            borderRadius: 8,
            border: '1.5px solid rgba(74, 158, 255, 0.7)',
            background: 'rgba(74, 158, 255, 0.08)',
            boxShadow: '0 8px 24px var(--shadow-node)',
            pointerEvents: 'none',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            backdropFilter: 'blur(2px)',
          }}
        >
          {/* Mock title bar */}
          <div
            style={{
              height: 24,
              background: 'var(--surface-2)',
              borderBottom: `1px solid var(--border-subtle)`,
              display: 'flex',
              alignItems: 'center',
              padding: '0 10px',
              fontSize: 11,
              color: 'var(--text-primary)',
              fontWeight: 500,
              letterSpacing: 0.2,
            }}
          >
            {draggedPanelTitle ??
              (draggedPanelType ? PANEL_TYPE_LABELS[draggedPanelType] : 'Panel')}
          </div>
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'rgba(74, 158, 255, 0.85)',
              fontSize: 11,
              fontWeight: 500,
              userSelect: 'none',
            }}
          >
            Drop to place here
          </div>
        </div>
        )
      })()}
    </div>
  )
}
