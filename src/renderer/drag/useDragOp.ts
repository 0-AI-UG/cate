// =============================================================================
// useDragOp — thin React dispatcher for the drag runtime. Translates DOM/IPC
// events into DragEvents fed through `reduce`, then publishes the resulting
// DragState into useDragStore and runs the emitted DragEffects (DOM attribute
// toggles, IPC calls, commitDrop, etc.).
// =============================================================================

import React, { useCallback } from 'react'
import type { Point, Size, PanelTransferSnapshot } from '../../shared/types'
import { PANEL_DEFAULT_SIZES, PANEL_CANVAS_DROP_SIZES } from '../../shared/types'
import { useDragStore } from './store'
import type { DragSource, DragOpSourceSpec, RuntimeState } from './types'
import { reduce, initial as runtimeInitial } from './runtime'
import { resolveDrop } from './resolve'
import { commitDrop } from './commit'
import { normalizeGrabOffset } from './geometry'
import { dockTabGrabOffset } from './grabOffset'
import { findNodeIdForDockStore } from '../panels/nodeDockRegistry'
import type { CanvasStore } from '../stores/canvasStore'
import { getDefaultSession, type ActiveDispatch } from './session'
import type { StoreApi } from 'zustand'
import type { PanelType } from '../../shared/types'
import { createTransferSnapshot } from '../lib/panelTransfer'
import { terminalRegistry } from '../lib/terminal/terminalRegistry'
import { prepareTerminalRemount } from './terminalRemount'
import { useAppStore } from '../stores/appStore'
import { removeDetachedPanelRecords } from '../lib/canvas/removeDetachedPanelRecords'
import { useSettingsStore } from '../stores/settingsStore'

const DEAD_ZONE_PX = 4

// -----------------------------------------------------------------------------
// Dispatcher state — owned by the DragSession (per-window). The default
// singleton is used here; `useDragOp` will eventually thread the per-window
// session in, but in Phase 3 the singleton covers every real-world case
// (only one window has the cursor at any moment).
// -----------------------------------------------------------------------------

function attachListeners() {
  const session = getDefaultSession()
  if (session.listenersAttached) return
  window.addEventListener('mousemove', onMouseMove, true)
  window.addEventListener('mouseup', onMouseUp, true)
  // Bubble phase (not capture): we only want the window's own blur event.
  // Capture-phase would also fire for element-level blur events bubbling up,
  // and xterm's textarea.focus() — triggered by the focus-on-focus effect on
  // terminal panels — would otherwise cancel an in-flight drag.
  window.addEventListener('blur', onBlur, false)
  session.listenersAttached = true
  // Body marker so resize-cursor / resize-start can guard against starting an
  // edge-resize on top of an in-flight drag. Mirrors `canvas-interacting`
  // which is set by the resize hook.
  document.body.classList.add('canvas-dragging')
}

function detachListeners() {
  const session = getDefaultSession()
  if (!session.listenersAttached) return
  window.removeEventListener('mousemove', onMouseMove, true)
  window.removeEventListener('mouseup', onMouseUp, true)
  window.removeEventListener('blur', onBlur, false)
  session.listenersAttached = false
  document.body.classList.remove('canvas-dragging')
}

// -----------------------------------------------------------------------------
// Helpers — measurement + spec normalization + snapshot construction.
// -----------------------------------------------------------------------------

function specToDragSource(spec: DragOpSourceSpec): DragSource {
  if (spec.kind === 'canvas-node') {
    return {
      panelId: spec.panelId,
      origin: {
        kind: 'canvas-node',
        canvasStoreApi: spec.canvasStoreApi,
        nodeId: spec.nodeId,
      },
    }
  }
  if (spec.kind === 'panel-window') {
    return { panelId: spec.panelId, origin: { kind: 'panel-window' } }
  }
  return {
    panelId: spec.panelId,
    origin: {
      kind: 'dock-tab',
      dockStoreApi: spec.dockStoreApi,
      zone: spec.zone,
      stackId: spec.stackId,
      sourceNodeId: spec.sourceNodeId,
      sourceCanvasStoreApi: spec.sourceCanvasStoreApi,
    },
  }
}

function cursorInsideWindow(client: Point): boolean {
  return (
    client.x >= 0 &&
    client.y >= 0 &&
    client.x <= window.innerWidth &&
    client.y <= window.innerHeight
  )
}

/** Find the canvas container that owns a given canvas store (so we can convert
 *  client coords → canvas-space without depending on the node DOM element).
 *  Resolves the panelId via the session's reverse index, then looks up the
 *  matching container by `data-canvas-panel-id`. */
function findCanvasContainerForStore(
  canvasStoreApi: StoreApi<CanvasStore>,
): { rect: DOMRect; zoom: number; viewportOffset: Point } | null {
  const panelId = getDefaultSession().getPanelIdForCanvasStore(canvasStoreApi)
  if (!panelId) return null
  const containers = document.querySelectorAll<HTMLElement>('[data-canvas-container]')
  let el: HTMLElement | null = null
  for (const c of containers) {
    if (c.getAttribute('data-canvas-panel-id') === panelId) { el = c; break }
  }
  if (!el) return null
  const state = canvasStoreApi.getState()
  return { rect: el.getBoundingClientRect(), zoom: state.zoomLevel, viewportOffset: state.viewportOffset }
}

/** Grab + ghost for a canvas-node-shaped drag. Computes the grab offset from
 *  the cursor's canvas-space position vs the node's known origin — completely
 *  independent of which DOM element the user clicked, so dragging from a tab
 *  produces identical numbers to dragging from the title bar. */
function measureCanvasNodeGrab(
  canvasStoreApi: StoreApi<CanvasStore>,
  nodeId: string,
  cursorClient: Point,
  fallbackPanelType: PanelType,
): { grab: Point; ghostSize: Size; ghostZoom: number } {
  const state = canvasStoreApi.getState()
  const node = state.nodes[nodeId]
  const zoom = state.zoomLevel
  if (!node) {
    return {
      grab: { x: 0, y: 12 },
      ghostSize: PANEL_DEFAULT_SIZES[fallbackPanelType],
      ghostZoom: zoom,
    }
  }
  // If the node is currently maximized, the spring-load effect (see
  // CanvasNode's drag-store subscription) will un-maximize it ~200ms into
  // the drag, snapping node.size/origin back to preMaximizeSize/Origin. The
  // ghost is sized once at START and isn't re-measured, so taking the live
  // maximized size would leave a huge stale ghost as soon as spring-load
  // fires. Use the pre-maximize geometry up-front so the ghost matches the
  // node's actual post-spring-load footprint (this mirrors the 0.4.4
  // behaviour that was lost in the unified-drag refactor).
  const isMaximized = node.preMaximizeOrigin != null && node.preMaximizeSize != null
  const effectiveSize: Size = isMaximized && node.preMaximizeSize
    ? { width: node.preMaximizeSize.width, height: node.preMaximizeSize.height }
    : { width: node.size.width, height: node.size.height }
  const effectiveOrigin: Point = isMaximized && node.preMaximizeOrigin
    ? { x: node.preMaximizeOrigin.x, y: node.preMaximizeOrigin.y }
    : { x: node.origin.x, y: node.origin.y }

  const container = findCanvasContainerForStore(canvasStoreApi)
  if (!container) {
    return {
      grab: { x: effectiveSize.width / 2, y: 12 },
      ghostSize: effectiveSize,
      ghostZoom: zoom,
    }
  }
  // Convert cursor (client coords) → canvas-space.
  const localView: Point = {
    x: cursorClient.x - container.rect.left,
    y: cursorClient.y - container.rect.top,
  }
  const cursorCanvas: Point = {
    x: (localView.x - container.viewportOffset.x) / Math.max(zoom, 0.01),
    y: (localView.y - container.viewportOffset.y) / Math.max(zoom, 0.01),
  }
  // For a maximized node, project the grab proportionally into the pre-maximize
  // rect so the cursor stays at the same relative spot inside the (smaller)
  // ghost — otherwise grabbing the right side of a maximized node would put
  // the cursor far outside a much smaller pre-maximize ghost.
  if (isMaximized) {
    const fx = (cursorCanvas.x - node.origin.x) / Math.max(node.size.width, 1)
    const fy = (cursorCanvas.y - node.origin.y) / Math.max(node.size.height, 1)
    return {
      grab: { x: fx * effectiveSize.width, y: fy * effectiveSize.height },
      ghostSize: effectiveSize,
      ghostZoom: zoom,
    }
  }
  return {
    grab: { x: cursorCanvas.x - effectiveOrigin.x, y: cursorCanvas.y - effectiveOrigin.y },
    ghostSize: effectiveSize,
    ghostZoom: zoom,
  }
}

function measureDragGeometry(
  spec: DragOpSourceSpec,
  cursorClient: Point,
  sourceRect: DOMRect | null,
): { grab: Point; ghostSize: Size; ghostZoom: number } {
  if (spec.kind === 'canvas-node') {
    return measureCanvasNodeGrab(spec.canvasStoreApi, spec.nodeId, cursorClient, spec.panelType)
  }

  if (spec.kind === 'panel-window') {
    // Ghost mirrors the panel window itself — use the renderer's inner size
    // so the receiving canvas/dock places a node of the same footprint.
    const ghostSize: Size = {
      width: Math.max(window.innerWidth, 200),
      height: Math.max(window.innerHeight, 120),
    }
    const grab: Point = sourceRect
      ? { x: cursorClient.x - sourceRect.left, y: cursorClient.y - sourceRect.top }
      : { x: ghostSize.width / 2, y: 12 }
    return { grab, ghostSize, ghostZoom: 1 }
  }

  // dock-tab: when this tab lives in a per-canvas-node mini-dock, fall back to
  // the canvas-node measurement (DockTabStack normally re-dispatches as a
  // canvas-node spec before reaching here, so this only fires when the spec
  // was built without resolving the canvas store up front).
  const owningNodeId =
    spec.sourceNodeId ?? findNodeIdForDockStore(spec.dockStoreApi)
  const canvasStoreApi = owningNodeId
    ? getDefaultSession().reconcileCanvasStoreForNode(owningNodeId, spec.sourceCanvasStoreApi)
    : null
  if (owningNodeId && canvasStoreApi) {
    return measureCanvasNodeGrab(canvasStoreApi, owningNodeId, cursorClient, spec.panelType)
  }

  // Non-canvas-node dock-tab source (e.g. a tab in a side/main dock zone). The
  // ghost previews the eventual canvas-drop footprint, so use the compact
  // canvas-drop default rather than the (larger) free-window default.
  const ghostSize: Size = { ...PANEL_CANVAS_DROP_SIZES[spec.panelType] }
  if (sourceRect) {
    return {
      grab: dockTabGrabOffset({ cursorClient, sourceRect, ghostSize }),
      ghostSize,
      ghostZoom: 1,
    }
  }
  return { grab: { x: ghostSize.width / 2, y: 12 }, ghostSize, ghostZoom: 1 }
}

function buildSnapshotFor(spec: DragOpSourceSpec): PanelTransferSnapshot | null {
  // PanelState rides on the spec — dock windows keep panel data in
  // component-local state and never populate useAppStore, so reading from
  // the global store would yield null for tabs dragged out of a detached
  // dock window.
  const panel = spec.panel

  // For canvas-type panels, the snapshot needs each child's PanelState so the
  // receiving window can render real child panels instead of "Panel" stubs.
  const app = useAppStore.getState()
  const sourceWs = app.workspaces.find((w) => w.id === app.selectedWorkspaceId)
  const resolveChildPanel = (childId: string) => sourceWs?.panels[childId]
  // Carry the source workspace root so the detached window inherits a cwd for
  // new terminals (otherwise its stub workspace has none and re-prompts).
  const rootPath = sourceWs?.rootPath || undefined

  if (spec.kind === 'canvas-node') {
    const node = spec.canvasStoreApi.getState().nodes[spec.nodeId]
    if (!node) return null
    return createTransferSnapshot(
      panel,
      { type: 'canvas', canvasId: '', canvasNodeId: spec.nodeId },
      { origin: node.origin, size: node.size },
      { resolveChildPanel, workspaceRootPath: rootPath },
    )
  }

  if (spec.kind === 'panel-window') {
    const drag = useDragStore.getState()
    const size = drag.ghostSize ?? PANEL_DEFAULT_SIZES[spec.panelType]
    // windowId is filled in by the main process during PANEL_RECEIVE routing;
    // 0 is a placeholder ("the source detached window") that nothing reads back.
    return createTransferSnapshot(
      panel,
      { type: 'detached', windowId: 0 },
      { origin: { x: 0, y: 0 }, size },
      { resolveChildPanel, workspaceRootPath: rootPath },
    )
  }

  const drag = useDragStore.getState()
  const size = drag.ghostSize ?? PANEL_DEFAULT_SIZES[spec.panelType]
  return createTransferSnapshot(
    panel,
    { type: 'dock', zone: spec.zone, stackId: spec.stackId },
    { origin: { x: 0, y: 0 }, size },
    { resolveChildPanel, workspaceRootPath: rootPath },
  )
}

// -----------------------------------------------------------------------------
// Effect runner — translates DragEffects from the reducer into side effects.
// -----------------------------------------------------------------------------

function runEffects(prevActive: ActiveDispatch, next: RuntimeState) {
  for (const eff of next.effects) {
    switch (eff.kind) {
      case 'set-body-class':
        if (eff.on) document.body.classList.add(eff.cls)
        else document.body.classList.remove(eff.cls)
        break
      case 'push-history':
        if (prevActive.spec.kind === 'canvas-node') {
          try {
            prevActive.spec.canvasStoreApi.getState().pushHistory()
          } catch {
            // Best-effort.
          }
        }
        break
      case 'cross-window-start':
        window.electronAPI?.crossWindowDragStart(eff.snapshot, eff.screen)
        break
      case 'cross-window-cancel':
        window.electronAPI?.crossWindowDragCancel()
        break
      case 'commit':
        commitDrop(eff.source, eff.target, eff.panel, {
          crossWindowResolve: async () => {
            if (!window.electronAPI?.crossWindowDragResolve) return { claimed: false }
            return window.electronAPI.crossWindowDragResolve()
          },
          crossWindowCancel: () => {
            window.electronAPI?.crossWindowDragCancel()
          },
          dragDetach: async (snapshot, workspaceId) => {
            if (!window.electronAPI?.dragDetach) return null
            if (window.electronAPI.isMainWindowFullscreen?.()) return null
            return window.electronAPI.dragDetach(snapshot, workspaceId)
          },
          buildSnapshot: () => buildSnapshotFor(prevActive.spec),
          workspaceId: resolveOwningWorkspaceId(prevActive.ownerWorkspaceId),
          onRemovedFromCanvas: (panelId, panelType) => {
            if (panelType === 'terminal') terminalRegistry.release(panelId)
            const wsId = resolveOwningWorkspaceId(prevActive.ownerWorkspaceId)
            // If the user just detached the workspace's only canvas, spawn a
            // fresh empty one so they don't end up staring at an empty dock.
            // The detached window keeps the contents that were carried via
            // PanelTransferSnapshot.canvasState.
            if (panelType === 'canvas') {
              const app = useAppStore.getState()
              const ws = app.workspaces.find((w) => w.id === wsId)
              if (ws) {
                const remainingCanvases = Object.values(ws.panels).filter(
                  (p) => p.type === 'canvas' && p.id !== panelId,
                )
                if (remainingCanvases.length === 0) {
                  app.createCanvas(wsId)
                }
              }
            }
            // The panel now lives in the detached window — drop it (and a
            // canvas's children) from this workspace so the overview lists only
            // what's actually here. The receive side re-adds it on drop-back.
            removeDetachedPanelRecords(wsId, panelId, panelType)
          },
          prepareLocalRemount: (panelId, panelType) => {
            prepareTerminalRemount(panelId, panelType, terminalRegistry)
          },
        }).catch((err) => {
          // eslint-disable-next-line no-console
          console.warn('[useDragOp] commitDrop failed', err)
        })
        break
      case 'clear-state':
        // Final state published below also clears; nothing extra to do here.
        break
    }
  }
}

/** Resolve the workspace id that owns the dragged panel. In a main window this
 *  is the live selection. In a detached PANEL window selectedWorkspaceId is the
 *  in-window stub id (and may be '' before a panel is ensured), so callers pass
 *  the shell's effective id (`workspaceId || 'detached-panel-window'`) which we
 *  prefer over the (possibly empty/stub) store value. */
function resolveOwningWorkspaceId(override?: string): string {
  if (override) return override
  return useAppStore.getState().selectedWorkspaceId
}

/** Reduce + publish state + run effects. Returns the updated runtime state. */
function step(prevActive: ActiveDispatch, event: Parameters<typeof reduce>[1]): RuntimeState {
  const next = reduce(prevActive.runtime, event)
  // Publish the new DragState slice into the store.
  useDragStore.getState().applyDragState(next.state)
  runEffects(prevActive, next)
  return next
}

// -----------------------------------------------------------------------------
// Listeners
// -----------------------------------------------------------------------------

function onMouseMove(ev: MouseEvent) {
  const session = getDefaultSession()
  const active = session.active
  if (!active) return
  const client: Point = { x: ev.clientX, y: ev.clientY }
  const screen: Point = { x: ev.screenX, y: ev.screenY }
  active.lastClient = client
  active.lastScreen = screen

  // Dead-zone arming.
  if (!active.runtime.armed) {
    const dx = client.x - active.initialClient.x
    const dy = client.y - active.initialClient.y
    if (Math.hypot(dx, dy) < DEAD_ZONE_PX) return
    armDrag()
  }

  const inside = cursorInsideWindow(client)
  // Build snapshot on the just-crossed boundary in case the runtime needs it
  // to emit a cross-window-start effect.
  const wasInside = active.runtime.state.cursor?.insideWindow ?? true
  const snapshot =
    wasInside && !inside && !active.runtime.crossWindowActive
      ? buildSnapshotFor(active.spec)
      : null

  active.runtime = step(active, {
    type: 'MOVE',
    client,
    screen,
    insideWindow: inside,
    snapshot,
  })

  // Resolve the drop target for visual + commit. Snap to grid when the user
  // enabled it and isn't holding Alt (the temporary bypass modifier).
  const drag = useDragStore.getState()
  if (drag.source && drag.grab && drag.ghostSize && drag.panel) {
    const snap = useSettingsStore.getState().snapToGrid && !ev.altKey
    const target = resolveDrop(
      { client, screen, insideWindow: inside },
      drag.source,
      drag.grab,
      drag.ghostSize,
      drag.panel.type,
      { snap },
    )
    active.runtime = step(active, { type: 'TARGET', target })
  }
}

function armDrag() {
  const session = getDefaultSession()
  const active = session.active
  if (!active) return
  const spec = active.spec
  const dragSource = specToDragSource(spec)

  // Source-element visibility is now driven by useDragSourceVisibility (a
  // zustand selector keyed off the published DragState.source), so the
  // dispatcher no longer needs to locate or mutate any DOM element here.

  active.runtime = step(active, {
    type: 'START',
    source: dragSource,
    panel: { id: spec.panelId, type: spec.panelType, title: spec.panelTitle },
    grab: active.grab,
    ghostSize: active.ghostSize,
    ghostZoom: active.ghostZoom,
    cursor: active.initialClient,
  })
  session.wasDragged.current = true
}

function onMouseUp(_ev: MouseEvent) {
  const session = getDefaultSession()
  const active = session.active
  if (!active) return
  session.active = null
  detachListeners()
  step(active, { type: 'END' })
}

function onBlur() {
  const session = getDefaultSession()
  const active = session.active
  if (!active) return
  session.active = null
  detachListeners()
  step(active, { type: 'CANCEL' })
}

// -----------------------------------------------------------------------------
// Hook
// -----------------------------------------------------------------------------

export type { DragOpSourceSpec } from './types'

export function useDragOp(opts?: { workspaceId?: string }): {
  handleDragStart: (e: React.MouseEvent, spec: DragOpSourceSpec) => void
  wasDragged: { current: boolean }
} {
  const ownerWorkspaceId = opts?.workspaceId
  const handleDragStart = useCallback((e: React.MouseEvent, spec: DragOpSourceSpec) => {
    const session = getDefaultSession()
    if (session.active) return
    if (e.button !== 0) return
    // First-gesture-wins: an in-flight resize blocks new drags for the same
    // pointer gesture. Resize sets `canvas-interacting` on body in
    // useNodeResize.handleResizeStart.
    if (document.body.classList.contains('canvas-interacting')) return
    session.wasDragged.current = false

    const cursorClient: Point = { x: e.clientX, y: e.clientY }
    const cursorScreen: Point = { x: e.screenX, y: e.screenY }

    let sourceRect: DOMRect | null = null
    const el = e.currentTarget as HTMLElement | null
    if (el) sourceRect = el.getBoundingClientRect()
    // For drags whose ghost represents a whole canvas-node, measure grab relative
    // to the node element (not the tab/strip the user clicked on), so the cursor
    // sticks to the corresponding point inside the ghost.
    const ghostHostNodeId =
      spec.kind === 'canvas-node'
        ? spec.nodeId
        : spec.kind === 'dock-tab'
          ? spec.sourceNodeId ?? null
          : null
    if (ghostHostNodeId) {
      const nodeEl = document.querySelector<HTMLElement>(`[data-node-id="${ghostHostNodeId}"]`)
      if (nodeEl) sourceRect = nodeEl.getBoundingClientRect()
    }

    const { grab, ghostSize, ghostZoom } = measureDragGeometry(spec, cursorClient, sourceRect)

    session.active = {
      spec,
      initialClient: cursorClient,
      initialScreen: cursorScreen,
      lastClient: cursorClient,
      lastScreen: cursorScreen,
      grab,
      ghostSize,
      ghostZoom,
      runtime: runtimeInitial,
      ownerWorkspaceId,
    }
    attachListeners()
  }, [ownerWorkspaceId])

  return { handleDragStart, wasDragged: getDefaultSession().wasDragged }
}
