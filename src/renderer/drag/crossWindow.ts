// =============================================================================
// drag/crossWindow — IPC bridge for drags initiated in another renderer. Owns
// a per-window runtime that mirrors the cross-window drag so this window's
// `resolveDrop` + `DragOverlay` see the same state shape as a local drag (one
// state machine for both flows, no direct store patching).
//
// Lifecycle for an incoming remote drag:
//   onCrossWindowDragUpdate(screen, snapshot) → first time cursor lands inside
//     this window → START a remote-source runtime + publish state.
//   subsequent updates → MOVE (insideWindow=true|false) + TARGET (resolveDrop).
//   onDragEnd → END (commits via host onDrop + IPC claim if a target is set).
// =============================================================================

import type { Point, Size, PanelTransferSnapshot, DockDropTarget } from '../../shared/types'
import type { StoreApi } from 'zustand'
import type { CanvasStore } from '../stores/canvasStore'
import type { DockStore } from '../stores/dockStore'
import { useDragStore } from './store'
import { resolveDrop } from './resolve'
import { useSettingsStore } from '../stores/settingsStore'
import { reduce, initial as runtimeInitial } from './runtime'
import { remoteDragGrab } from './remoteGrab'
import { placeNodeOnCanvas } from './commit'
import type { DragEvent, DragSource, RuntimeState } from './types'
import { applyBodyClassEffect } from './types'

export type RemoteDropTarget =
  | { kind: 'dock'; target: DockDropTarget; dockStoreApi: StoreApi<DockStore> }
  | {
      kind: 'canvas'
      canvasStoreApi: StoreApi<CanvasStore>
      origin: Point
      size: Size
    }

export type RemoteDropHandler = (
  snapshot: PanelTransferSnapshot,
  target: RemoteDropTarget,
) => void

interface ActiveRemote {
  snapshot: PanelTransferSnapshot
  runtime: RuntimeState
  onDrop: RemoteDropHandler | undefined
  /** Id of the drag session this window is tracking, from the DRAG_UPDATE that
   *  STARTed it. A targeted DRAG_END only ends THIS drag when ids match. */
  dragId: string
}

let activeRemote: ActiveRemote | null = null

/** True when a targeted DRAG_END ends a different drag session. */
export function shouldIgnoreDragEnd(
  activeDragId: string,
  payloadDragId: string,
): boolean {
  return activeDragId !== payloadDragId
}

function buildRemoteSource(snapshot: PanelTransferSnapshot): DragSource {
  return {
    panelId: snapshot.panel.id,
    origin: { kind: 'remote', snapshot },
  }
}

function step(active: ActiveRemote, event: DragEvent): RuntimeState {
  const next = reduce(active.runtime, event)
  active.runtime = next
  useDragStore.getState().applyDragState(next.state)
  runRemoteEffects(active, next)
  return next
}

function runRemoteEffects(active: ActiveRemote, state: RuntimeState): void {
  for (const eff of state.effects) {
    switch (eff.kind) {
      case 'set-body-class':
        applyBodyClassEffect(eff)
        break
      case 'commit': {
        // Only handle remote-source commits here — local commits go through
        // useDragOp's effect runner.
        if (eff.source.origin.kind !== 'remote') break
        const target = eff.target
        let remoteTarget: RemoteDropTarget | null = null
        if (target.kind === 'dock-tab') {
          // route drop to the resolved DockStore so canvas-node mini-dock targets land in the right tree
          remoteTarget = {
            kind: 'dock',
            target: { type: 'tab', stackId: target.stackId },
            dockStoreApi: target.dockStoreApi,
          }
        } else if (target.kind === 'dock-split') {
          remoteTarget = {
            kind: 'dock',
            target: { type: 'split', stackId: target.stackId, edge: target.edge },
            dockStoreApi: target.dockStoreApi,
          }
        } else if (target.kind === 'dock-zone') {
          remoteTarget = {
            kind: 'dock',
            target: { type: 'zone', zone: target.zone },
            dockStoreApi: target.dockStoreApi,
          }
        } else if (target.kind === 'canvas-add') {
          remoteTarget = {
            kind: 'canvas',
            canvasStoreApi: target.canvasStoreApi,
            origin: target.origin,
            size: target.size,
          }
        }
        if (remoteTarget && active.onDrop) {
          // Claim FIRST — main is the arbiter. Only materialize the panel when
          // main accepts: a claim landing after the drag already resolved
          // unclaimed means the source has fallen back to a detach window, and
          // materializing here too would duplicate the panel.
          const { snapshot, onDrop } = active
          const claimedTarget = remoteTarget
          Promise.resolve(window.electronAPI.crossWindowDragDrop(snapshot.panel.id))
            .then((result) => {
              if (result?.accepted) onDrop(snapshot, claimedTarget)
            })
            .catch(() => {
              // Claim IPC failed — don't materialize; the source still owns the panel.
            })
        }
        break
      }
      // Remote drags never emit these — listed for exhaustiveness.
      case 'cross-window-start':
      case 'cross-window-cancel':
      case 'push-history':
        break
    }
  }
}

/** Build the host's remote-drop callback. The shared logic is identical across
 *  windows — refuse canvas-on-canvas cross-window drops, then place the panel
 *  on the resolved dock or canvas target. The ONLY per-window difference is the
 *  add-panel step (workspace `addPanel` vs dock window `ensurePanelsInAppStore`)
 *  and the hydrate that precedes it, so callers pass that as `addPanelStep`. */
export function createRemoteDropHandler(opts: {
  addPanelStep: (snapshot: PanelTransferSnapshot) => void
}): RemoteDropHandler {
  return (snapshot, target) => {
    // Canvas-on-canvas is unsupported: refuse cross-window drops of a
    // canvas panel onto a canvas target. The source window stays as-is.
    if (snapshot.panel.type === 'canvas' && target.kind !== 'dock') return

    // Deposit PTY hand-off + hydrate canvas children + register the panel
    // before it mounts (per-window: addPanel vs ensurePanelsInAppStore).
    opts.addPanelStep(snapshot)

    if (target.kind === 'dock') {
      const dockTarget = target.target
      target.dockStoreApi.getState().dockPanel(
        snapshot.panel.id,
        dockTarget.type === 'zone' ? dockTarget.zone : 'center',
        dockTarget,
      )
    } else {
      placeNodeOnCanvas(
        target.canvasStoreApi,
        snapshot.panel.id,
        snapshot.panel.type,
        target.origin,
        target.size,
      )
    }
  }
}

/** Wire cross-window drag IPC for this window's lifecycle. Returns a cleanup.
 *  `onDrop` is the host's window-local registration callback (e.g. addPanel
 *  into a workspace, or setPanels for a dock window). It fires for both
 *  dock-targeted and canvas-targeted drops; the host branches on
 *  `target.kind`. Detach targets are not surfaced — those mean the cursor was
 *  outside this window, so there's nothing to claim here. */
export function setupCrossWindowDragListeners(
  onDrop?: RemoteDropHandler,
): () => void {
  const cleanups: (() => void)[] = []

  cleanups.push(
    window.electronAPI.onCrossWindowDragUpdate((screenPos: Point, snapshot: PanelTransferSnapshot, dragId: string) => {
      const localX = screenPos.x - window.screenX
      const localY = screenPos.y - window.screenY
      const inside =
        localX >= 0 && localY >= 0 && localX < window.innerWidth && localY < window.innerHeight
      const client: Point = { x: localX, y: localY }

      if (!activeRemote) {
        // Only START once the cursor has entered this window — outside-cursor
        // updates before entry are ignored. (Matches the prior behavior; the
        // ghost shouldn't render in a window the cursor never touched.)
        if (!inside) return
        activeRemote = {
          snapshot,
          runtime: runtimeInitial,
          onDrop,
          dragId,
        }
        step(activeRemote, {
          type: 'START',
          source: buildRemoteSource(snapshot),
          panel: {
            id: snapshot.panel.id,
            type: snapshot.panel.type,
            title: snapshot.panel.title,
          },
          grab: remoteDragGrab(snapshot),
          ghostSize: snapshot.geometry.size,
          ghostZoom: 1,
          cursor: client,
        })
      } else {
        step(activeRemote, {
          type: 'MOVE',
          client,
          screen: screenPos,
          insideWindow: inside,
        })
      }

      const drag = useDragStore.getState()
      // Only resolve a target while the cursor is inside this window. When
      // outside, clear the target so a stale highlight from the last
      // inside-update doesn't linger.
      // Honor this (receiving) window's snap-to-grid setting. Keyboard state
      // doesn't ride along the cross-window IPC, so the Alt bypass only applies
      // to same-window drags.
      const target =
        inside && drag.source && drag.grab && drag.ghostSize && drag.panel
          ? resolveDrop(
              { client, screen: screenPos, insideWindow: true },
              drag.source,
              drag.grab,
              drag.ghostSize,
              drag.panel.type,
              { snap: useSettingsStore.getState().snapToGrid },
            )
          : null
      if (activeRemote) step(activeRemote, { type: 'TARGET', target })
    }),
  )

  cleanups.push(
    window.electronAPI.onDragEnd((dragId: string) => {
      const active = activeRemote
      if (!active) return
      // Ignore a DRAG_END that ends a DIFFERENT drag — e.g. a detach completing
      // in another window must not force-cancel THIS window's active drag.
      if (shouldIgnoreDragEnd(active.dragId, dragId)) return
      activeRemote = null
      // END emits a 'commit' effect iff a target is set; runRemoteEffects
      // handles the IPC claim + onDrop callback.
      step(active, { type: 'END' })
    }),
  )

  return () => {
    cleanups.forEach((fn) => fn())
    if (activeRemote) {
      const active = activeRemote
      activeRemote = null
      step(active, { type: 'CANCEL' })
    }
  }
}
