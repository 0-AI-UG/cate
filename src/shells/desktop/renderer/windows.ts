// Native detached windows for the document's detached windows (the `windows`
// feature). The main window opens and closes them from the document; each
// detached window reports its own moves and close requests as document ops
// on its connection.

import type { Rect } from '@workspace/canvas/contract'
import { documentStoreFor } from '@client/document'
import { clampToScreens, closeDetachedWindow, type WindowsPort } from '@client/layout/windows'
import type { Bounds, DesktopApi } from '../contract'

const toBounds = (rect: Rect): Bounds => ({ x: rect.origin.x, y: rect.origin.y, width: rect.size.width, height: rect.size.height })
const toRect = (bounds: Bounds): Rect => ({ origin: { x: bounds.x, y: bounds.y }, size: { width: bounds.width, height: bounds.height } })

function screens(): { x: number; y: number; width: number; height: number }[] {
  if (typeof window === 'undefined' || !window.screen) return []
  const s = window.screen as Screen & { availLeft?: number; availTop?: number }
  return [{ x: s.availLeft ?? 0, y: s.availTop ?? 0, width: s.availWidth, height: s.availHeight }]
}

export function createWindowsPort(api: DesktopApi): WindowsPort {
  return {
    open: ({ workspaceId, windowId, bounds }) => {
      void api.windows.open({ workspaceId, windowId, bounds: toBounds(clampToScreens(bounds, screens())) })
    },
    close: (ref) => { void api.windows.close(ref) },
    // Moves are reported by the detached window itself (`attachDetachedWindow`).
    onBoundsChanged: () => () => {},
    focus: (ref) => { void api.windows.focus(ref) },
    // A new window next to a fullscreen one would land in another Space.
    canOpen: () => !api.window.anyFullscreen(),
  }
}

/** The detached window's side: its moves become `setWindowBounds` (not an
 *  edit to undo), and the user closing it becomes `closeWindow` after the
 *  close guards. */
export function attachDetachedWindow(api: DesktopApi, workspaceId: string, windowId: string): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const stopBounds = api.window.onBounds((bounds) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      const store = documentStoreFor(workspaceId)
      if (!store?.getSnapshot().windows[windowId]) return
      store.propose({ kind: 'setWindowBounds', windowId, bounds: toRect(bounds) }, { undoable: false })
    }, 250)
  })
  const stopClose = api.window.onCloseRequested(() => { void closeDetachedWindow(workspaceId, windowId) })
  return () => {
    if (timer) clearTimeout(timer)
    stopBounds()
    stopClose()
  }
}
