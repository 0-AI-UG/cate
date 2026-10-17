// Keeps native windows in step with the document's detached windows on a
// client with `windows`: a new detached window opens, a removed one closes.
// Whether a window exists and what it holds is shared; where it sits is not.
// The client that detaches a panel says where its window opens here
// (`openWindowAt`); every other client opens it where its shell puts it.

import type { Rect } from '@workspace/canvas/contract'
import { documentStoreFor } from '@client/document'
import { detachedWindows } from './panelIndex'
import type { WindowsPort } from './ports'

const firstBounds = new Map<string, Rect>()
const keyOf = (workspaceId: string, windowId: string) => `${workspaceId}/${windowId}`

/** Opens the detached window `windowId` at `bounds` on this device once the
 *  document has it. Call before proposing the op that creates it. */
export function openWindowAt(workspaceId: string, windowId: string, bounds: Rect): void {
  firstBounds.set(keyOf(workspaceId, windowId), bounds)
}

export function syncDetachedWindows(workspaceId: string, port: WindowsPort): () => void {
  const store = documentStoreFor(workspaceId)
  if (!store) return () => {}
  const open = new Set<string>()

  const sync = () => {
    const windows = detachedWindows(store.getSnapshot())
    const present = new Set(windows.map((window) => window.id))
    for (const window of windows) {
      if (open.has(window.id)) continue
      open.add(window.id)
      const key = keyOf(workspaceId, window.id)
      const bounds = firstBounds.get(key)
      firstBounds.delete(key)
      port.open({ workspaceId, windowId: window.id, ...(bounds ? { bounds } : {}) })
    }
    for (const windowId of [...open]) {
      if (present.has(windowId)) continue
      open.delete(windowId)
      port.close({ workspaceId, windowId })
    }
  }

  const stop = store.subscribe(sync)
  sync()

  return () => {
    stop()
    for (const windowId of open) port.close({ workspaceId, windowId })
    open.clear()
  }
}
