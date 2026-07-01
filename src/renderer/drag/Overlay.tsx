// =============================================================================
// DragOverlay — single ghost + drop indicator renderer per window shell.
// Subscribes to the global dragStore and portals overlays into document.body.
// =============================================================================

import React from 'react'
import { createPortal } from 'react-dom'
import { useDragStore } from './store'
import type { DragSource, DropTarget } from './types'
import { getDropZoneEntries } from './registry'
import { ghostScreenRect } from './geometry'

export default function DragOverlay() {
  const isDragging = useDragStore((s) => s.isDragging)
  const panel = useDragStore((s) => s.panel)
  const source = useDragStore((s) => s.source)
  const grab = useDragStore((s) => s.grab)
  const ghostSize = useDragStore((s) => s.ghostSize)
  const ghostZoom = useDragStore((s) => s.ghostZoom)
  const cursor = useDragStore((s) => s.cursor)
  const target = useDragStore((s) => s.target)

  if (!isDragging || !panel || !cursor || !grab || !ghostSize) return null
  // Native main-process ghost owns the visual when cursor is outside.
  if (!cursor.insideWindow) return null

  // ghostZoom was frozen at drag-start (= the source canvas's zoom). For a
  // canvas-node source it keeps the ghost size + grab offset stable as the
  // cursor crosses zones, mirroring the source visually.
  //
  // But a source that ISN'T on a canvas (dock tab, panel window) is frozen at
  // zoom 1, while a canvas-add drop sizes the landed node by ghostSize in
  // canvas-space — i.e. rendered at the *target* canvas's current zoom. Freezing
  // at 1 makes the ghost preview the wrong footprint whenever that canvas isn't
  // at 100%. So when such a source hovers a canvas, render the ghost at the
  // target canvas's live zoom so it previews the real landing size.
  const renderZoom =
    source && source.origin.kind !== 'canvas-node' && target?.kind === 'canvas-add'
      ? (target.canvasStoreApi.getState().zoomLevel ?? ghostZoom)
      : ghostZoom

  // When snap-to-grid is active and the cursor is over a canvas, resolveDrop
  // attaches `ghostRect` — the screen-px rect of the snapped landing cell — so
  // the ghost previews where the panel will actually land (visibly stepping
  // between grid cells as you drag). Otherwise the ghost free-tracks the cursor
  // 1:1, mirroring the panel under the pointer.
  const snappedRect =
    target && (target.kind === 'canvas-reposition' || target.kind === 'canvas-add')
      ? target.ghostRect
      : undefined
  const rect = snappedRect ?? ghostScreenRect(cursor.client, grab, ghostSize, renderZoom)

  // Group drag: draw a ghost for every other selected member too, each offset
  // from the anchor ghost by its canvas-space start delta (× renderZoom). The
  // anchor's rect already tracks the cursor (or the snapped cell), so members
  // ride along keeping their original relative spacing — matching the commit,
  // which translates every member by the same snapped anchor delta.
  const memberGhosts = source ? memberGhostRects(source, rect, renderZoom) : []

  return createPortal(
    <div data-drag-overlay="true" style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 10000 }}>
      <GhostWindow
        left={rect.left}
        top={rect.top}
        width={rect.width}
        height={rect.height}
        title={panel.title}
      />
      {memberGhosts.map((m) => (
        <GhostWindow key={m.key} left={m.left} top={m.top} width={m.width} height={m.height} title="" />
      ))}
      <DropIndicator target={target} />
    </div>,
    document.body,
  )
}

// -----------------------------------------------------------------------------
// Group-drag member ghosts — one rect per other selected node, positioned by
// its canvas-space offset from the anchor node at drag-start. Sizes are read
// live from the source canvas store (members don't move until commit).
// -----------------------------------------------------------------------------

export function memberGhostRects(
  source: DragSource,
  anchorRect: { left: number; top: number; width: number; height: number },
  renderZoom: number,
): { key: string; left: number; top: number; width: number; height: number }[] {
  if (source.origin.kind !== 'canvas-node') return []
  const { members, startOrigin, canvasStoreApi } = source.origin
  if (!members?.length || !startOrigin) return []
  const nodes = canvasStoreApi.getState().nodes
  const out: { key: string; left: number; top: number; width: number; height: number }[] = []
  for (const m of members) {
    const node = nodes[m.nodeId]
    if (!node) continue
    out.push({
      key: m.nodeId,
      left: anchorRect.left + (m.startOrigin.x - startOrigin.x) * renderZoom,
      top: anchorRect.top + (m.startOrigin.y - startOrigin.y) * renderZoom,
      width: node.size.width * renderZoom,
      height: node.size.height * renderZoom,
    })
  }
  return out
}

// -----------------------------------------------------------------------------
// Ghost — window-shaped rect mirroring the panel that will land.
// -----------------------------------------------------------------------------

function GhostWindow({
  left,
  top,
  width,
  height,
  title,
}: {
  left: number
  top: number
  width: number
  height: number
  title: string
}) {
  return (
    <div
      data-drag-overlay-ghost="true"
      style={{
        position: 'absolute',
        left,
        top,
        width,
        height,
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
        {title}
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
        Drop to place
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Drop indicator — for dock targets, paints a translucent rect over the target
// stack's edge / tab bar. Canvas-* and detach targets need no extra indicator
// (the ghost itself shows the landing position).
// -----------------------------------------------------------------------------

type Rect = { left: number; top: number; width: number; height: number }

function DropIndicator({ target }: { target: DropTarget | null }) {
  if (!target) return null
  // dock-tab: DockTabStack itself renders an inline "+ new tab" placeholder at
  // the actual insertion slot — drawing a full-width rect over the tab bar
  // here would just obscure that more precise affordance.
  if (target.kind === 'dock-tab') return null
  if (target.kind !== 'dock-split' && target.kind !== 'dock-zone') {
    return null
  }

  const stack = lookupStackRect(target)
  if (!stack) return null
  const { rect: stackRect, clip } = stack

  if (target.kind === 'dock-zone') {
    // Clamp to the stack's canvas container (if any) so the indicator never
    // paints over the sidebar or the canvas tab-bar strip — a per-node mini-dock
    // rect extends under those when the node sits past the canvas edge (its DOM
    // rect ignores the canvas's overflow-clip).
    const r = clampToClip(stackRect, clip)
    if (!r) return null
    return (
      <div
        data-drag-indicator="zone"
        style={{
          position: 'absolute',
          left: r.left,
          top: r.top,
          width: r.width,
          height: r.height,
          backgroundColor: 'rgba(74, 158, 255, 0.08)',
          border: '2px dashed rgba(74, 158, 255, 0.4)',
          borderRadius: 6,
          pointerEvents: 'none',
        }}
      />
    )
  }

  // dock-split: half the rect on the edge.
  const edge = target.edge
  const half: Rect = {
    left: stackRect.left,
    top: stackRect.top,
    width: stackRect.width,
    height: stackRect.height,
  }
  if (edge === 'top') half.height = stackRect.height / 2
  else if (edge === 'bottom') {
    half.top = stackRect.top + stackRect.height / 2
    half.height = stackRect.height / 2
  } else if (edge === 'left') half.width = stackRect.width / 2
  else if (edge === 'right') {
    half.left = stackRect.left + stackRect.width / 2
    half.width = stackRect.width / 2
  }

  const r = clampToClip(half, clip)
  if (!r) return null
  return (
    <div
      data-drag-indicator={`split-${edge}`}
      style={{
        position: 'absolute',
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
        backgroundColor: 'rgba(74, 158, 255, 0.12)',
        border: '2px solid rgba(74, 158, 255, 0.5)',
        borderRadius: 6,
        pointerEvents: 'none',
      }}
    />
  )
}

/** Intersect a screen-px rect with its clip rect (the stack's canvas container).
 *  Returns null when there's no overlap. With no clip, the rect passes through. */
function clampToClip(rect: Rect, clip: Rect | null): Rect | null {
  if (!clip) return rect
  const left = Math.max(rect.left, clip.left)
  const top = Math.max(rect.top, clip.top)
  const right = Math.min(rect.left + rect.width, clip.left + clip.width)
  const bottom = Math.min(rect.top + rect.height, clip.top + clip.height)
  if (right <= left || bottom <= top) return null
  return { left, top, width: right - left, height: bottom - top }
}

function lookupStackRect(target: DropTarget): { rect: Rect; clip: Rect | null } | null {
  if (target.kind !== 'dock-split' && target.kind !== 'dock-tab' && target.kind !== 'dock-zone') return null
  for (const entry of getDropZoneEntries()) {
    const matches =
      (target.kind === 'dock-zone'
        ? !entry.stackId && entry.zone === target.zone
        : entry.stackId === (target as { stackId: string }).stackId) &&
      entry.dockStoreApi === target.dockStoreApi
    if (!matches) continue
    const r = entry.getRect()
    if (!r) continue
    // The stack's nearest canvas container clips per-node mini-dock indicators to
    // the canvas surface. Main-window dock stacks have no canvas ancestor → no clip.
    const container = entry.getElement?.()?.closest<HTMLElement>('[data-canvas-container]')
    const cr = container?.getBoundingClientRect() ?? null
    return {
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      clip: cr ? { left: cr.left, top: cr.top, width: cr.width, height: cr.height } : null,
    }
  }
  return null
}
