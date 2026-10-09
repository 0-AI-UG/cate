// Native detached windows for the document's detached windows (the `windows`
// feature). The main window opens and closes them from the document; each
// detached window reports its close requests as a document op on its
// connection. Where a window sits is this device's (main keeps it).

import type { Rect } from '@workspace/canvas/contract'
import { clampToScreens, closeDetachedWindow, type WindowsPort } from '../ui/client/layout/windows'
import type { Bounds, DesktopApi } from '../contract'

const toBounds = (rect: Rect): Bounds => ({ x: rect.origin.x, y: rect.origin.y, width: rect.size.width, height: rect.size.height })

function screens(): { x: number; y: number; width: number; height: number }[] {
  if (typeof window === 'undefined' || !window.screen) return []
  const s = window.screen as Screen & { availLeft?: number; availTop?: number }
  return [{ x: s.availLeft ?? 0, y: s.availTop ?? 0, width: s.availWidth, height: s.availHeight }]
}

export function createWindowsPort(api: DesktopApi): WindowsPort {
  return {
    open: ({ workspaceId, windowId, bounds }) => {
      void api.windows.open({ workspaceId, windowId, bounds: bounds && toBounds(clampToScreens(bounds, screens())) })
    },
    close: (ref) => { void api.windows.close(ref) },
    focus: (ref) => { void api.windows.focus(ref) },
    // A new window next to a fullscreen one would land in another Space.
    canOpen: () => !api.window.anyFullscreen(),
  }
}

/** The detached window's side: the user closing it becomes `closeWindow`
 *  after the close guards. */
export function attachDetachedWindow(api: DesktopApi, workspaceId: string, windowId: string): () => void {
  return api.window.onCloseRequested(() => { void closeDetachedWindow(workspaceId, windowId) })
}
