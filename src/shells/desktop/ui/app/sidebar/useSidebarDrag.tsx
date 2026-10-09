// Dragging rows of the workspace tree. Like a header chip, a lifted row leaves
// the list, a dashed ghost row shows where it would land and a copy follows the
// cursor. Only this tree listens (pointer events here, not the panel drag
// system): panel rows move between layouts and splits, layout headings only
// reorder their window's layouts.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LayoutId, PanelId, WindowId } from '@workspace/document/contract'
import { clientStateFor, documentStoreFor } from '@client/document'
import { canLiveOnCanvas, moveLayout } from '@client/host'
import { proposeDrop } from '../../client/layout/drag'
import { CANVAS_ORDER_KEY, type WindowTree } from './panelTree'
import {
  canvasOrderAt,
  layoutSlots,
  nearestSlot,
  panelDropChange,
  panelSlots,
  type CanvasSlot,
  type DropSlot,
  type LayoutSlot,
  type RectOf,
} from './sidebarDrag'

/** Pointer travel before a press on a row becomes a drag. */
const DRAG_THRESHOLD_PX = 4

export type DragRow = { kind: 'panel'; panelId: PanelId } | { kind: 'layout'; windowId: WindowId; layoutId: LayoutId }

/** What the lifted row looks like under the cursor and as the ghost. */
export interface RowLook {
  label: string
  icon: React.ReactNode
}

export type SidebarDrag =
  | { kind: 'panel'; panelId: PanelId; slot: DropSlot | null; look: RowLook; float: Float }
  | { kind: 'layout'; windowId: WindowId; layoutId: LayoutId; slot: LayoutSlot | null; look: RowLook; float: Float }

interface Float { left: number; top: number; width: number }

export function useSidebarDrag(workspaceId: string, windows: readonly WindowTree[]) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const windowsRef = useRef(windows)
  windowsRef.current = windows
  const [drag, setDrag] = useState<SidebarDrag | null>(null)
  const justDragged = useRef(false)
  const stop = useRef<(() => void) | null>(null)
  useEffect(() => () => stop.current?.(), [])

  const begin = useCallback((e: React.PointerEvent<HTMLElement>, row: DragRow, look: RowLook) => {
    const container = containerRef.current
    if (e.button !== 0 || !container) return
    const startY = e.clientY
    const own = e.currentTarget.getBoundingClientRect()
    let slots: DropSlot[] | LayoutSlot[] | null = null
    let bounds: DOMRect | null = null
    let slot: DropSlot | LayoutSlot | null = null
    const float = (y: number): Float => ({ left: own.left, top: own.top + y - startY, width: own.width })

    const lift = () => {
      // Rects as the rows stand now, with the lifted row still in place.
      const rects = new Map<string, DOMRect>()
      for (const el of container.querySelectorAll<HTMLElement>('[data-sb-key]')) rects.set(el.dataset.sbKey!, el.getBoundingClientRect())
      const rectOf: RectOf = (key) => rects.get(key) ?? null
      bounds = container.getBoundingClientRect()
      if (row.kind === 'panel') {
        const type = documentStoreFor(workspaceId)?.getSnapshot().panels[row.panelId]?.type
        slots = panelSlots(windowsRef.current, row.panelId, rectOf, type !== 'canvas' && canLiveOnCanvas(type))
      }
      else {
        const window = windowsRef.current.find((w) => w.windowId === row.windowId)
        slots = window ? layoutSlots(window, row.layoutId, rectOf) : []
      }
    }

    const move = (ev: PointerEvent) => {
      if (!slots) {
        if (Math.abs(ev.clientY - startY) < DRAG_THRESHOLD_PX) return
        lift()
        globalThis.getSelection?.()?.removeAllRanges()
      }
      const inside = !!bounds && ev.clientX >= bounds.left && ev.clientX <= bounds.right
      slot = inside ? nearestSlot(slots as (DropSlot | LayoutSlot)[], ev.clientY, ev.clientX) : null
      setDrag(row.kind === 'panel'
        ? { kind: 'panel', panelId: row.panelId, slot: slot as DropSlot | null, look, float: float(ev.clientY) }
        : { kind: 'layout', windowId: row.windowId, layoutId: row.layoutId, slot: slot as LayoutSlot | null, look, float: float(ev.clientY) })
    }

    const end = () => {
      stop.current?.()
      setDrag(null)
      if (!slots) return
      justDragged.current = true // swallows the click that follows the release
      globalThis.setTimeout(() => { justDragged.current = false }, 0)
      if (!slot) return
      if (row.kind === 'panel') {
        // Where it was dropped among a canvas's children is kept in the list, though the canvas ignores it.
        if ('canvasId' in (slot as DropSlot)) {
          clientStateFor(workspaceId)?.setPanelView((slot as CanvasSlot).canvasPanelId, CANVAS_ORDER_KEY, canvasOrderAt(windowsRef.current, slot as CanvasSlot, row.panelId))
        }
        const doc = documentStoreFor(workspaceId)?.getSnapshot()
        const change = doc && panelDropChange(doc, row.panelId, slot as DropSlot, () => globalThis.crypto.randomUUID())
        if (change) proposeDrop(workspaceId, [change], row.panelId, true)
      } else {
        const layouts = documentStoreFor(workspaceId)?.getSnapshot().windows[row.windowId]?.layouts
        const index = (slot as LayoutSlot).index
        if (layouts && layouts.findIndex((l) => l.id === row.layoutId) !== index) moveLayout(workspaceId, row.windowId, row.layoutId, index)
      }
    }

    stop.current?.()
    stop.current = () => {
      globalThis.removeEventListener('pointermove', move)
      globalThis.removeEventListener('pointerup', end)
      globalThis.removeEventListener('pointercancel', end)
      stop.current = null
    }
    globalThis.addEventListener('pointermove', move)
    globalThis.addEventListener('pointerup', end)
    globalThis.addEventListener('pointercancel', end)
  }, [workspaceId])

  /** True once, for the click a finished drag leaves behind. */
  const consumeClick = useCallback(() => {
    const was = justDragged.current
    justDragged.current = false
    return was
  }, [])

  return { containerRef, drag, begin, consumeClick }
}

/** The lifted row under the cursor, in the tree's row style. */
export function DragFloat({ look, float }: { look: RowLook; float: Float }) {
  return createPortal(
    <div
      aria-hidden
      data-sidebar-drag-float
      className="fixed z-[10000] pointer-events-none flex items-center gap-1.5 h-7 px-2 text-[13px] rounded-lg bg-surface-2 text-primary shadow-lg"
      style={{ left: float.left, top: float.top, width: float.width }}
    >
      <span className="shrink-0 flex">{look.icon}</span>
      <span className="min-w-0 flex-1 truncate">{look.label}</span>
    </div>,
    document.body,
  )
}
