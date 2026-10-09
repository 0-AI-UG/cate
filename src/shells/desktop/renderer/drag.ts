// The drag shell over the desktop IPC: main runs the native ghost and relays
// the pointer to the other windows. The client's drag id maps to main's.

import type { Point } from '@workspace/canvas/contract'
import { documentStoreFor } from '@client/document'
import type { CrossWindowDrag, CrossWindowPort, DragGhostPort, DragShell } from '../ui/client/layout/drag'
import type { DesktopApi, DragPointer } from '../contract'

const DEFAULT_SIZE = { width: 480, height: 320 }
const RELAYED_GRAB = { x: 12, y: 12 }

export function createDragShell(api: DesktopApi, snapToGrid: () => boolean): DragShell {
  const started = new Map<string, Promise<string | null>>()
  const start = (drag: CrossWindowDrag) => {
    let id = started.get(drag.dragId)
    if (!id) {
      id = api.drag.start({ workspaceId: drag.workspaceId, panelId: drag.panelId, title: drag.title, size: drag.size }).catch(() => null)
      started.set(drag.dragId, id)
    }
    return id
  }
  const take = (dragId: string) => {
    const id = started.get(dragId)
    started.delete(dragId)
    return id ?? Promise.resolve(null)
  }

  // A relayed drag carries main's id; the receiver claims with it.
  const relayed = ({ dragId, payload }: DragPointer): CrossWindowDrag => ({
    dragId,
    workspaceId: payload.workspaceId,
    panelId: payload.panelId,
    panelType: documentStoreFor(payload.workspaceId)?.getSnapshot().panels[payload.panelId]?.type ?? 'unknown',
    title: payload.title,
    size: payload.size ?? DEFAULT_SIZE,
    grab: RELAYED_GRAB,
  })

  const ghost: DragGhostPort = {
    show: (drag) => { void start(drag) },
    // Main hides the ghost over app windows and removes it when the drag ends.
    hide: () => {},
  }
  const crossWindow: CrossWindowPort = {
    begin: (drag) => { void start(drag) },
    cancel(dragId) {
      void take(dragId).then((id) => { if (id) void api.drag.cancel(id) })
    },
    async release(dragId) {
      const id = await take(dragId)
      return id ? api.drag.end(id) : { claimed: false }
    },
    onPointer: (listener: (drag: CrossWindowDrag, screen: Point) => void) =>
      api.drag.onPointer((pointer) => listener(relayed(pointer), { x: pointer.x, y: pointer.y })),
    onEnd: (listener) => api.drag.onEnded(listener),
    claim: async (dragId) => (await api.drag.claim(dragId)) !== null,
  }
  return { ghost, crossWindow, snapToGrid }
}
