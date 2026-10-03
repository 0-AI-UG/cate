// Keeps native windows in step with the document's detached windows on a
// client with `windows`: a new detached window opens, a removed one closes,
// bounds another client set move it, and a move here goes back as one
// `setWindowBounds` op once the window settles.

import { sameRect, type Rect } from '@workspace/canvas/contract'
import { documentStoreFor } from '@client/document'
import { detachedWindows } from './panelIndex'
import type { WindowsPort } from './ports'

export function syncDetachedWindows(workspaceId: string, port: WindowsPort): () => void {
  const store = documentStoreFor(workspaceId)
  if (!store) return () => {}
  const open = new Map<string, Rect>()

  const sync = () => {
    const windows = detachedWindows(store.getSnapshot())
    const present = new Set(windows.map((window) => window.id))
    for (const window of windows) {
      const bounds = window.bounds
      if (!bounds) continue
      const shown = open.get(window.id)
      if (!shown) {
        open.set(window.id, bounds)
        port.open({ workspaceId, windowId: window.id, bounds })
      } else if (!sameRect(shown, bounds)) {
        open.set(window.id, bounds)
        port.setBounds?.({ workspaceId, windowId: window.id }, bounds)
      }
    }
    for (const windowId of [...open.keys()]) {
      if (present.has(windowId)) continue
      open.delete(windowId)
      port.close({ workspaceId, windowId })
    }
  }

  const stopDoc = store.subscribe(sync)
  const stopBounds = port.onBoundsChanged((window, bounds) => {
    if (window.workspaceId !== workspaceId || !open.has(window.windowId)) return
    const current = store.getSnapshot().windows[window.windowId]?.bounds
    open.set(window.windowId, bounds)
    if (current && sameRect(current, bounds)) return
    // Moving a window is not an edit to undo.
    store.propose({ kind: 'setWindowBounds', windowId: window.windowId, bounds }, { undoable: false })
  })
  sync()

  return () => {
    stopDoc()
    stopBounds()
    for (const windowId of open.keys()) port.close({ workspaceId, windowId })
    open.clear()
  }
}
