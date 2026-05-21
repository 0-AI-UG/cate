// =============================================================================
// DragOverlay — single ghost + drop indicator renderer per window shell.
// Subscribes to the global dragStore and portals overlays into document.body.
// =============================================================================

import React from 'react'
import { createPortal } from 'react-dom'
import { useDragStore } from './store'
import type { DropTarget } from './types'
import { getDropZoneEntries } from './registry'
import { ghostScreenRect } from './geometry'
import type { Point } from '../../shared/types'

export default function DragOverlay() {
  const isDragging = useDragStore((s) => s.isDragging)
  const panel = useDragStore((s) => s.panel)
  const grab = useDragStore((s) => s.grab)
  const ghostSize = useDragStore((s) => s.ghostSize)
  const ghostZoom = useDragStore((s) => s.ghostZoom)
  const cursor = useDragStore((s) => s.cursor)
  const target = useDragStore((s) => s.target)

  if (!isDragging || !panel || !cursor || !grab || !ghostSize) return null
  // Native main-process ghost owns the visual when cursor is outside.
  if (!cursor.insideWindow) return null

  // ghostZoom was frozen at drag-start (= the source canvas's zoom). Using it
  // keeps the ghost size + grab offset consistent throughout the drag — both
  // mirror the source visually regardless of which canvas/dock the cursor
  // currently hovers over.
  const rect = ghostScreenRect(cursor.client, grab, ghostSize, ghostZoom)

  return createPortal(
    <div data-drag-overlay="true" style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 10000 }}>
      <GhostWindow
        left={rect.left}
        top={rect.top}
        width={rect.width}
        height={rect.height}
        title={panel.title}
      />
      <DropIndicator target={target} />
    </div>,
    document.body,
  )
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

function DropIndicator({ target }: { target: DropTarget | null }) {
  if (!target) return null
  // dock-tab: DockTabStack itself renders an inline "+ new tab" placeholder at
  // the actual insertion slot — drawing a full-width rect over the tab bar
  // here would just obscure that more precise affordance.
  if (target.kind === 'dock-tab') return null
  if (target.kind !== 'dock-split' && target.kind !== 'dock-zone') {
    return null
  }

  const stackRect = lookupStackRect(target)
  if (!stackRect) return null

  if (target.kind === 'dock-zone') {
    return (
      <div
        data-drag-indicator="zone"
        style={{
          position: 'absolute',
          left: stackRect.left,
          top: stackRect.top,
          width: stackRect.width,
          height: stackRect.height,
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
  const half = {
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

  return (
    <div
      data-drag-indicator={`split-${edge}`}
      style={{
        position: 'absolute',
        ...half,
        backgroundColor: 'rgba(74, 158, 255, 0.12)',
        border: '2px solid rgba(74, 158, 255, 0.5)',
        borderRadius: 6,
        pointerEvents: 'none',
      }}
    />
  )
}

function lookupStackRect(target: DropTarget): { left: number; top: number; width: number; height: number } | null {
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
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  }
  return null
}

// Avoid unused warnings on point type if downstream consumers reach for it.
export type { Point }
