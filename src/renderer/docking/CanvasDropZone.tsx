// =============================================================================
// CanvasDropZone — full-area drop target shown over a canvas while a panel
// or canvas-node is being dragged. The dragged item appears as a window-
// shaped ghost following the cursor; releasing drops the new node at that
// position. Also handles cross-canvas moves and dock→canvas detach.
// =============================================================================

import { useEffect, useRef, useState } from 'react'
import type { StoreApi } from 'zustand'
import type { CanvasStore } from '../stores/canvasStore'
import { findCanvasStoreForNode } from '../stores/canvasStore'
import { useDockDragStore, getDropZoneEntries } from '../hooks/useDockDrag'
import { useDockStore } from '../stores/dockStore'
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

/** Outer strip (in px) reserved for the underlying DockTabStack's split-edge
 *  targets (top / bottom / left / right). When the cursor is inside this strip
 *  we deactivate the canvas drop so the dock's normal split indicator wins.
 *  Kept tight so most of the canvas reads as drop-into-canvas territory. */
const EDGE_STRIP = 32

function CanvasDropZoneInner({ canvasStoreApi }: CanvasDropZoneProps) {
  const overlayRef = useRef<HTMLDivElement>(null)
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

  // Source size in canvas-space units. This is the size the new node will
  // have when added to the target canvas.
  let sourceSize =
    (draggedPanelType && PANEL_DEFAULT_SIZES[draggedPanelType]) ??
    { width: 600, height: 400 }
  // Ghost is rendered in screen-space, so scale by the target canvas zoom
  // to match what the node will actually look like once dropped.
  const targetZoom = canvasStoreApi.getState().zoomLevel
  // Screen-pixel offset from cursor to ghost top-left. Preference order:
  //   1. canvas source → use grabOffset × targetZoom (canvas-space)
  //   2. dock source → use dock rect directly in screen-pixels (no scaling)
  //   3. fallback → center on cursor
  let ghostPxSize: { width: number; height: number }
  let ghostOffset: { x: number; y: number }
  if (dragSource?.type === 'canvas') {
    const sourceCanvas = findCanvasStoreForNode(dragSource.nodeId)
    const srcNode = sourceCanvas?.getState().nodes[dragSource.nodeId]
    if (srcNode) {
      sourceSize = { width: srcNode.size.width, height: srcNode.size.height }
    }
    ghostPxSize = { width: sourceSize.width * targetZoom, height: sourceSize.height * targetZoom }
    ghostOffset = grabOffsetCanvas
      ? { x: grabOffsetCanvas.x * targetZoom, y: grabOffsetCanvas.y * targetZoom }
      : { x: ghostPxSize.width / 2, y: ghostPxSize.height / 2 }
  } else if (dragSource?.type === 'dock' && dockSourceSize && grabOffsetCanvas) {
    // Preview at the canvas-default size (what the dropped node will actually
    // be), not the source dock rect — otherwise the ghost looks huge compared
    // to the resulting node. Rescale the grab offset proportionally so the
    // cursor stays at the same relative spot inside the ghost.
    ghostPxSize = { width: sourceSize.width * targetZoom, height: sourceSize.height * targetZoom }
    ghostOffset = {
      x: (grabOffsetCanvas.x / dockSourceSize.width) * ghostPxSize.width,
      y: (grabOffsetCanvas.y / dockSourceSize.height) * ghostPxSize.height,
    }
  } else {
    ghostPxSize = { width: sourceSize.width * targetZoom, height: sourceSize.height * targetZoom }
    ghostOffset = { x: ghostPxSize.width / 2, y: ghostPxSize.height / 2 }
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
    const inEdgeStrip =
      !(x > EDGE_STRIP &&
        y > EDGE_STRIP &&
        x < rect.width - EDGE_STRIP &&
        y < rect.height - EDGE_STRIP)
    // Also yield to any registered mini-dock drop zone the cursor is sitting
    // over — those are canvas-node mini-docks layered above the canvas, and
    // we want their tab/split indicators to win over "Drop into canvas".
    // Main-window dock zones (left/right/bottom) sit outside this overlay's
    // rect so they're handled implicitly by onPointerLeave.
    const overMiniDock = getDropZoneEntries().some((entry) => {
      if (!entry.dockStoreApi) return false
      const r = entry.getRect()
      if (!r) return false
      return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom
    })
    const center = !inEdgeStrip && !overMiniDock
    setCursor({ x, y })
    setInCenter(center)
    inCenterRef.current = center
    // The source's mousemove handler checks this flag to decide whether to
    // run its own hit-test. Only claim the cursor when we're in the center —
    // otherwise let the dock's split-edge / mini-dock indicators fire.
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

        // --- Remove from source -----------------------------------------
        if (dragSource?.type === 'dock') {
          const sourceStore = sourceDockStoreApi ?? useDockStore
          sourceStore.getState().undockPanel(draggedPanelId)
        } else if (dragSource?.type === 'canvas') {
          // Self-drop guard: dropping back onto the same canvas → no-op move
          // (the canvas-node body drag's regular path already moved it).
          if (canvasStoreApi.getState().nodes[dragSource.nodeId]) {
            useDockDragStore.getState().endDrag()
            document.body.classList.remove('canvas-interacting')
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
        // Place the node's top-left so it matches the ghost preview. For
        // canvas sources the grab offset is already in canvas-space. For
        // dock sources it's in screen pixels and must be divided by zoom.
        // The dropped node uses `sourceSize` (canvas default), but we want
        // its top-left to match where the ghost was, which for dock is the
        // grab offset centered on the real rect → we recenter inside the
        // smaller canvas-default window to keep the cursor inside it.
        let offsetX: number
        let offsetY: number
        if (dragSource?.type === 'canvas' && grabOffsetCanvas) {
          offsetX = grabOffsetCanvas.x
          offsetY = grabOffsetCanvas.y
        } else if (dragSource?.type === 'dock' && dockSourceSize && grabOffsetCanvas) {
          // Proportional offset inside the new (canvas-default) node so the
          // cursor lands at the same relative position the user grabbed.
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
          style={{
            position: 'relative',
            overflow: 'hidden',
            borderRadius: 20,
            background: inCenter ? 'rgba(74, 158, 255, 0.15)' : 'var(--surface-3)',
            border: inCenter
              ? '1px solid rgba(74, 158, 255, 0.6)'
              : `1px solid var(--border-subtle)`,
            backdropFilter: 'blur(12px)',
            padding: '10px 24px',
            minWidth: 200,
            textAlign: 'center',
            transition:
              'background 200ms ease, border-color 200ms ease, transform 200ms cubic-bezier(0.16, 1, 0.3, 1)',
            transform: inCenter ? 'scale(1.05)' : 'scale(1)',
            animation: inCenter ? 'canvasDropPulse 1.2s ease-in-out infinite' : 'none',
          }}
        >
          <span
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: inCenter ? 'var(--focus-blue)' : 'var(--text-secondary)',
              transition: 'color 200ms ease',
              whiteSpace: 'nowrap',
              userSelect: 'none',
            }}
          >
            Drop into canvas
          </span>
        </div>
      </div>

      {/* Window-shaped ghost following the cursor — previews where the new
          node will land. Centered on the cursor. */}
      {cursor && (
        <div
          style={{
            position: 'absolute',
            left: cursor.x - ghostOffset.x,
            top: cursor.y - ghostOffset.y,
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
      )}
    </div>
  )
}
