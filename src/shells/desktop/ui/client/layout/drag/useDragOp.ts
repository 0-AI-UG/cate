// The drag dispatcher: DOM and shell events in, runtime steps, effects out.
// While the pointer moves only the ghost and the target change (client
// state); the release sends one document op (13.5).

import type React from 'react'
import { useCallback } from 'react'
import { viewToCanvas, type Point, type Size } from '@workspace/canvas/contract'
import { isCanvasDock, placementOf, type DocChange, type WorkspaceDocument } from '@workspace/document/contract'
import { clientStateFor, documentStoreFor } from '@client/document'
import { newId, panelDefaultSize, panelDropSize } from '@client/host'
import { windowsPort } from '../windows/ports'
import { openWindowAt } from '../windows/windowSync'
import { detachBounds, detachChange, dropChanges } from './commit'
import { acquireBodyClass, releaseBodyClass } from './dom'
import { dockTabGrabOffset } from './geometry'
import { dragShell, type CrossWindowDrag } from './ports'
import { canvasSurfaceFor } from './registry'
import { domDropEnvironment, resolveDrop, type DropEnvironment } from './resolve'
import { reduce, initial as runtimeInitial } from './runtime'
import { useDragStore } from './store'
import {
  type DragEffect,
  type DragEvent,
  type DragOpSourceSpec,
  type DragPanel,
  type DragSource,
  type DropTarget,
  type RuntimeState,
} from './types'

const DEAD_ZONE_PX = 4

interface ActiveDispatch {
  spec: DragOpSourceSpec
  panel: DragPanel
  dragId: string
  initialClient: Point
  grab: Point
  ghostSize: Size
  ghostZoom: number
  runtime: RuntimeState
}

let active: ActiveDispatch | null = null
let listenersAttached = false
const wasDragged = { current: false }

export function canDetach(): boolean {
  return windowsPort()?.canOpen?.() ?? true
}

function dropEnvironment(): DropEnvironment {
  return domDropEnvironment(canDetach)
}

/** Tests only. */
export function resetDragDispatch(): void {
  if (listenersAttached) detachListeners()
  active = null
  wasDragged.current = false
}

export function applyBodyClassEffect(effect: { cls: string; on: boolean }): void {
  if (effect.on) acquireBodyClass(effect.cls, 'drag-runtime')
  else releaseBodyClass(effect.cls)
}

function attachListeners(): void {
  if (listenersAttached) return
  window.addEventListener('mousemove', onMouseMove, true)
  window.addEventListener('mouseup', onMouseUp, true)
  // Capture, so Escape cancels the drag before the canvas clears its
  // selection on the same key.
  window.addEventListener('keydown', onKeyDown, true)
  // Bubble only: element blurs (xterm refocusing) must not cancel a drag.
  window.addEventListener('blur', onBlur, false)
  listenersAttached = true
  acquireBodyClass('canvas-dragging', 'drag-op-listeners')
}

function detachListeners(): void {
  if (!listenersAttached) return
  window.removeEventListener('mousemove', onMouseMove, true)
  window.removeEventListener('mouseup', onMouseUp, true)
  window.removeEventListener('keydown', onKeyDown, true)
  window.removeEventListener('blur', onBlur, false)
  listenersAttached = false
  releaseBodyClass('canvas-dragging')
}

/** The click that ends a drag must not also focus the node; the flag must
 *  not outlive that click. */
function clearWasDraggedAfterClick(): void {
  setTimeout(() => { if (!active) wasDragged.current = false }, 0)
}

function documentOf(workspaceId: string): WorkspaceDocument | null {
  return documentStoreFor(workspaceId)?.getSnapshot() ?? null
}

// --- Measuring --------------------------------------------------------------------

function specToSource(spec: DragOpSourceSpec): DragSource {
  if (spec.kind === 'canvas-node') {
    return {
      workspaceId: spec.workspaceId,
      panelId: spec.panelId,
      origin: { kind: 'canvas-node', canvasId: spec.canvasId, nodeId: spec.nodeId, startOrigin: spec.startOrigin, members: spec.members },
    }
  }
  return { workspaceId: spec.workspaceId, panelId: spec.panelId, origin: { kind: 'dock-tab', dock: spec.dock, stackId: spec.stackId } }
}

/** Grab and ghost of a whole node: the cursor's canvas point against the
 *  node's origin, whichever element was pressed (tab or title bar). */
function measureNode(
  workspaceId: string,
  canvasId: string,
  nodeId: string,
  cursorClient: Point,
  panelType: string,
): { grab: Point; ghostSize: Size; ghostZoom: number } {
  const node = documentOf(workspaceId)?.canvases[canvasId]?.nodes[nodeId]
  const surface = canvasSurfaceFor(workspaceId, canvasId)
  const viewport = surface?.getViewport() ?? { offset: { x: 0, y: 0 }, zoom: 1 }
  if (!node) return { grab: { x: 0, y: 12 }, ghostSize: panelDefaultSize(panelType), ghostZoom: viewport.zoom }
  const size = node.rect.size
  const container = surface?.getElement()
  if (!container) return { grab: { x: size.width / 2, y: 12 }, ghostSize: size, ghostZoom: viewport.zoom }
  const rect = container.getBoundingClientRect()
  const cursor = viewToCanvas({ x: cursorClient.x - rect.left, y: cursorClient.y - rect.top }, viewport.zoom, viewport.offset)
  return { grab: { x: cursor.x - node.rect.origin.x, y: cursor.y - node.rect.origin.y }, ghostSize: size, ghostZoom: viewport.zoom }
}

function measure(spec: DragOpSourceSpec, panelType: string, cursorClient: Point, sourceRect: DOMRect | null) {
  if (spec.kind === 'canvas-node') return measureNode(spec.workspaceId, spec.canvasId, spec.nodeId, cursorClient, panelType)
  if (isCanvasDock(spec.dock)) return measureNode(spec.workspaceId, spec.dock.canvasId, spec.dock.nodeId, cursorClient, panelType)
  // A window dock tab previews the compact canvas-drop footprint.
  const ghostSize: Size = { ...panelDropSize(panelType) }
  if (sourceRect) return { grab: dockTabGrabOffset({ cursorClient, sourceRect, ghostSize }), ghostSize, ghostZoom: 1 }
  return { grab: { x: ghostSize.width / 2, y: 12 }, ghostSize, ghostZoom: 1 }
}

function crossWindowDragFor(dispatch: ActiveDispatch): CrossWindowDrag {
  return {
    dragId: dispatch.dragId,
    workspaceId: dispatch.spec.workspaceId,
    panelId: dispatch.panel.id,
    panelType: dispatch.panel.type,
    title: dispatch.panel.title,
    size: dispatch.ghostSize,
    grab: { x: dispatch.grab.x * dispatch.ghostZoom, y: dispatch.grab.y * dispatch.ghostZoom },
  }
}

// --- Effects ------------------------------------------------------------------------

/** Proposes a drop's changes as one op, then shows the moved tab. */
export function proposeDrop(workspaceId: string, changes: DocChange[], panelId: string, activate: boolean): boolean {
  const store = documentStoreFor(workspaceId)
  if (!store || changes.length === 0) return false
  const result = store.propose(changes.length === 1 ? changes[0] : { kind: 'batch', changes })
  if (!result.ok || !activate) return result.ok
  const placement = placementOf(store.getSnapshot(), panelId)
  const state = clientStateFor(workspaceId)
  if (placement && state) {
    state.setActiveTab(placement.stackId, panelId)
    state.focus(panelId)
  }
  return true
}

/** Commits a local drop. A detach first asks the shell whether another
 *  window took it; otherwise it opens a new detached window. */
export async function commitDrop(
  source: DragSource,
  target: DropTarget,
  panel: DragPanel,
  geometry: { grab: Point; ghostSize: Size; ghostZoom: number; dragId: string },
): Promise<void> {
  const workspaceId = source.workspaceId
  if (target.kind !== 'detach') {
    const doc = documentOf(workspaceId)
    const changes = doc && dropChanges(doc, source, target, panel, { newId })
    if (changes) proposeDrop(workspaceId, changes, panel.id, target.kind !== 'canvas-reposition')
    return
  }
  const { beginPendingDetach, endPendingDetach } = useDragStore.getState()
  beginPendingDetach(panel.id, source.origin.kind === 'canvas-node' ? source.origin.nodeId : null)
  const before = documentOf(workspaceId)
  try {
    const shell = dragShell()
    shell.ghost?.hide(geometry.dragId)
    const { claimed } = shell.crossWindow ? await shell.crossWindow.release(geometry.dragId) : { claimed: false }
    if (claimed) {
      await movedOrTimeout(workspaceId, before, panel.id)
      return
    }
    if (!canDetach()) return
    const grab = { x: geometry.grab.x * geometry.ghostZoom, y: geometry.grab.y * geometry.ghostZoom }
    const windowId = newId()
    openWindowAt(workspaceId, windowId, detachBounds(target.screen, grab, geometry.ghostSize))
    proposeDrop(workspaceId, [detachChange(panel, windowId, newId)], panel.id, true)
  } finally {
    endPendingDetach(panel.id)
  }
}

/** Waits until the receiving window's op moved the panel, so the source does
 *  not flash back in between. */
function movedOrTimeout(workspaceId: string, before: WorkspaceDocument | null, panelId: string, timeoutMs = 1500): Promise<void> {
  const store = documentStoreFor(workspaceId)
  const was = before ? placementOf(before, panelId) : null
  if (!store) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); stop(); resolve() }
    const check = () => {
      const now = placementOf(store.getSnapshot(), panelId)
      if (!now || !was || now.stackId !== was.stackId) done()
    }
    const timer = setTimeout(done, timeoutMs)
    const stop = store.subscribe(check)
    check()
  })
}

function runEffects(dispatch: ActiveDispatch, effects: readonly DragEffect[]): void {
  const shell = dragShell()
  for (const effect of effects) {
    switch (effect.kind) {
      case 'set-body-class':
        applyBodyClassEffect(effect)
        break
      case 'cross-window-start':
        shell.ghost?.show(effect.drag, effect.screen)
        shell.crossWindow?.begin(effect.drag, effect.screen)
        break
      case 'cross-window-cancel':
        shell.ghost?.hide(effect.drag.dragId)
        shell.crossWindow?.cancel(effect.drag.dragId)
        break
      case 'commit':
        commitDrop(effect.source, effect.target, effect.panel, dispatch).catch((err) => {
          // eslint-disable-next-line no-console
          console.warn('[drag] drop failed', err)
        })
        break
    }
  }
}

function step(dispatch: ActiveDispatch, event: DragEvent): RuntimeState {
  const next = reduce(dispatch.runtime, event)
  dispatch.runtime = next
  useDragStore.getState().applyDragState(next.state)
  runEffects(dispatch, next.effects)
  return next
}

// --- Listeners ------------------------------------------------------------------------

function cursorInsideWindow(client: Point): boolean {
  return client.x >= 0 && client.y >= 0 && client.x <= window.innerWidth && client.y <= window.innerHeight
}

function onMouseMove(ev: MouseEvent): void {
  const dispatch = active
  if (!dispatch) return
  const client: Point = { x: ev.clientX, y: ev.clientY }
  const screen: Point = { x: ev.screenX, y: ev.screenY }
  if (!dispatch.runtime.armed) {
    if (Math.hypot(client.x - dispatch.initialClient.x, client.y - dispatch.initialClient.y) < DEAD_ZONE_PX) return
    step(dispatch, {
      type: 'START',
      source: specToSource(dispatch.spec),
      panel: dispatch.panel,
      grab: dispatch.grab,
      ghostSize: dispatch.ghostSize,
      ghostZoom: dispatch.ghostZoom,
      cursor: dispatch.initialClient,
    })
    wasDragged.current = true
  }

  const inside = cursorInsideWindow(client)
  // A group never leaves its canvas, so it never shows the native ghost.
  const grouped = dispatch.spec.kind === 'canvas-node' && !!dispatch.spec.members?.length
  const wasInside = dispatch.runtime.state.cursor?.insideWindow ?? true
  const shell = dragShell()
  const crossing = !grouped && wasInside && !inside && !dispatch.runtime.crossWindowActive && (!!shell.ghost || !!shell.crossWindow)
  step(dispatch, { type: 'MOVE', client, screen, insideWindow: inside, crossWindow: crossing ? crossWindowDragFor(dispatch) : null })

  const drag = useDragStore.getState()
  if (drag.source && drag.grab && drag.ghostSize && drag.panel) {
    const snap = (shell.snapToGrid?.() ?? false) && !ev.altKey
    const target = resolveDrop({ client, screen, insideWindow: inside }, drag.source, drag.grab, drag.ghostSize, drag.panel.type, {
      env: dropEnvironment(),
      snap,
    })
    step(dispatch, { type: 'TARGET', target })
  }
}

function finish(event: 'END' | 'CANCEL'): void {
  const dispatch = active
  if (!dispatch) return
  active = null
  detachListeners()
  step(dispatch, { type: event })
  clearWasDraggedAfterClick()
}

function onMouseUp(): void {
  finish('END')
}

function onBlur(): void {
  finish('CANCEL')
}

function onKeyDown(ev: KeyboardEvent): void {
  if (ev.key !== 'Escape' || !active) return
  // Escape only aborts the drag; the selection stays.
  ev.preventDefault()
  ev.stopPropagation()
  ev.stopImmediatePropagation()
  finish('CANCEL')
}

/** Starts watching a press that may become a drag (after a 4px dead zone).
 *  Ignored while another drag or gesture holds the pointer. */
export function beginDrag(e: Pick<MouseEvent, 'button' | 'clientX' | 'clientY'> & { currentTarget: EventTarget | null }, spec: DragOpSourceSpec): boolean {
  if (active || e.button !== 0) return false
  // First gesture wins: a resize in progress holds `canvas-interacting`.
  if (document.body.classList.contains('canvas-interacting')) return false
  const record = documentOf(spec.workspaceId)?.panels[spec.panelId]
  if (!record) return false
  wasDragged.current = false

  const cursorClient: Point = { x: e.clientX, y: e.clientY }
  let sourceRect: DOMRect | null = e.currentTarget instanceof Element ? e.currentTarget.getBoundingClientRect() : null
  // A ghost that stands for a whole node measures against the node element.
  const nodeId = spec.kind === 'canvas-node' ? spec.nodeId : isCanvasDock(spec.dock) ? spec.dock.nodeId : null
  if (nodeId) {
    const nodeEl = document.querySelector<HTMLElement>(`[data-node-id="${cssEscape(nodeId)}"]`)
    if (nodeEl) sourceRect = nodeEl.getBoundingClientRect()
  }
  const panel: DragPanel = { id: record.id, type: record.type, title: record.title }
  const { grab, ghostSize, ghostZoom } = measure(spec, record.type, cursorClient, sourceRect)
  active = {
    spec,
    panel,
    dragId: newId(),
    initialClient: cursorClient,
    grab,
    ghostSize,
    ghostZoom,
    runtime: runtimeInitial,
  }
  attachListeners()
  return true
}

const cssEscape = (value: string): string =>
  typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&')

export function useDragOp(): {
  handleDragStart: (e: React.MouseEvent, spec: DragOpSourceSpec) => void
  wasDragged: { current: boolean }
} {
  const handleDragStart = useCallback((e: React.MouseEvent, spec: DragOpSourceSpec) => {
    beginDrag(e, spec)
  }, [])
  return { handleDragStart, wasDragged }
}
