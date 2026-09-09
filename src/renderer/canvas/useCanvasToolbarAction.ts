import { useEffect, useRef } from 'react'

type CanvasToolbarAction = 'openWorktreeMenu' | 'openConversationMenu' | 'toggleCanvasToolbar'
const EVENT = 'canvas-toolbar-action'
interface ToolbarRequest { action: CanvasToolbarAction; canvasPanelId: string }

export function dispatchCanvasToolbarAction(action: CanvasToolbarAction, canvasPanelId: string): void {
  window.dispatchEvent(new CustomEvent<ToolbarRequest>(EVENT, { detail: { action, canvasPanelId } }))
}

/** Only the active canvas's control responds, including in detached windows. */
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
