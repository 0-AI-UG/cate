// Keyboard shortcuts reach a canvas's toolbar controls through a window
// event; only the canvas named in the request responds, in any window.

import { useEffect, useRef } from 'react'

export type CanvasToolbarAction = 'openWorktreeMenu' | 'openConversationMenu' | 'toggleCanvasToolbar'
const EVENT = 'canvas-toolbar-action'
interface ToolbarRequest { action: CanvasToolbarAction; canvasPanelId: string }

/** Asks the toolbar of one canvas (by its canvas panel) to run a control. */
export function requestCanvasToolbarAction(action: CanvasToolbarAction, canvasPanelId: string): void {
  window.dispatchEvent(new CustomEvent<ToolbarRequest>(EVENT, { detail: { action, canvasPanelId } }))
}

export function useCanvasToolbarAction(action: CanvasToolbarAction, canvasPanelId: string, run: () => void): void {
  const latest = useRef(run)
  latest.current = run
  useEffect(() => {
    const handle = (event: Event) => {
      const request = (event as CustomEvent<ToolbarRequest>).detail
      if (request.action === action && request.canvasPanelId === canvasPanelId) latest.current()
    }
    window.addEventListener(EVENT, handle)
    return () => window.removeEventListener(EVENT, handle)
  }, [action, canvasPanelId])
}
