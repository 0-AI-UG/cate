// A drag that started in another window of this client. The shell relays the
// pointer; this window runs its own runtime over it so hit testing and the
// ghost work as for a local drag. On release it claims the drop through the
// shell and, if the claim is accepted, sends the placement op itself. The
// panel's session never moves: both windows mirror the same document.

import type { Point } from '@workspace/canvas/contract'
import { newId } from '@client/host'
import { documentStoreFor } from '@client/document'
import { dropChanges } from './commit'
import type { CrossWindowDrag, CrossWindowPort } from './ports'
import { dragShell } from './ports'
import { resolveDrop, type DropEnvironment } from './resolve'
import { reduce, initial as runtimeInitial } from './runtime'
import { useDragStore } from './store'
import { applyBodyClassEffect, proposeDrop } from './useDragOp'
import type { DragEvent, DragSource, RuntimeState } from './types'

interface ActiveRemote {
  drag: CrossWindowDrag
  runtime: RuntimeState
}

/** Where the ghost's top-left sits relative to the relayed cursor. */
const REMOTE_GRAB = { x: 12, y: 12 } as const

export function shouldIgnoreDragEnd(activeDragId: string, endedDragId: string): boolean {
  return activeDragId !== endedDragId
}

/** Mirrors relayed drags in this window. Returns the cleanup. */
export function setupCrossWindowDrops(port: CrossWindowPort, env: () => DropEnvironment): () => void {
  let remote: ActiveRemote | null = null

  const step = (current: ActiveRemote, event: DragEvent) => {
    const next = reduce(current.runtime, event)
    current.runtime = next
    useDragStore.getState().applyDragState(next.state)
    for (const effect of next.effects) {
      if (effect.kind === 'set-body-class') applyBodyClassEffect(effect)
      else if (effect.kind === 'commit' && effect.source.origin.kind === 'remote') {
        const { drag } = effect.source.origin
        const target = effect.target
        const doc = documentStoreFor(drag.workspaceId)?.getSnapshot()
        const changes = doc && dropChanges(doc, effect.source, target, effect.panel, { newId })
        if (!changes) continue
        // The shell arbitrates: only an accepted claim sends the op, so a
        // drop the source already resolved as a detach is not doubled.
        port.claim(drag.dragId).then(
          (accepted) => { if (accepted) proposeDrop(drag.workspaceId, changes, effect.panel.id, true) },
          () => { /* the source keeps the panel */ },
        )
      }
    }
  }

  const source = (drag: CrossWindowDrag): DragSource => ({
    workspaceId: drag.workspaceId,
    panelId: drag.panelId,
    origin: { kind: 'remote', drag },
  })

  const stopPointer = port.onPointer((drag, screen: Point) => {
    const client = { x: screen.x - window.screenX, y: screen.y - window.screenY }
    const inside = client.x >= 0 && client.y >= 0 && client.x < window.innerWidth && client.y < window.innerHeight
    if (remote && remote.drag.dragId !== drag.dragId) {
      step(remote, { type: 'CANCEL' })
      remote = null
    }
    if (!remote) {
      // Only a window the cursor entered shows the drag.
      if (!inside) return
      remote = { drag, runtime: runtimeInitial }
      step(remote, {
        type: 'START',
        source: source(drag),
        panel: { id: drag.panelId, type: drag.panelType, title: drag.title },
        grab: REMOTE_GRAB,
        ghostSize: drag.size,
        ghostZoom: 1,
        cursor: client,
      })
    } else {
      step(remote, { type: 'MOVE', client, screen, insideWindow: inside })
    }
    const state = useDragStore.getState()
    // Keyboard state does not ride along the relay: no Alt bypass here.
    const target = inside && state.source && state.grab && state.ghostSize && state.panel
      ? resolveDrop({ client, screen, insideWindow: true }, state.source, state.grab, state.ghostSize, state.panel.type, {
          env: env(),
          snap: dragShell().snapToGrid?.() ?? false,
        })
      : null
    step(remote, { type: 'TARGET', target })
  })

  const stopEnd = port.onEnd((dragId) => {
    const current = remote
    if (!current || shouldIgnoreDragEnd(current.drag.dragId, dragId)) return
    remote = null
    step(current, { type: 'END' })
  })

  return () => {
    stopPointer()
    stopEnd()
    if (remote) {
      const current = remote
      remote = null
      step(current, { type: 'CANCEL' })
    }
  }
}
