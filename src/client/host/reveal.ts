// "Where is panel X, and bring it on screen": select its tab, and for a panel
// on a canvas also the canvas panel's tab and the node; show its window; focus
// it. The canvas view centres the node when it takes the reveal intent.

import { canvasPanelOf, isCanvasDock, placementOf, windowOf, type PanelId } from '@workspace/document/contract'
import { clientStateFor, documentStoreFor } from '@client/document'

/** Intent kind pushed on a canvas panel: `data` is `{ nodeId, panelId }`. */
export const CANVAS_REVEAL_INTENT = 'canvas.reveal'

export interface RevealHooks {
  /** Makes the workspace the one this window shows. */
  selectWorkspace?(workspaceId: string): void | Promise<void>
  /** Brings a document window on screen (raises a detached window, or
   *  switches to it on a client that shows every window in one). */
  showWindow?(workspaceId: string, windowId: string): void
}

let hooks: RevealHooks = {}

export function installRevealHooks(next: RevealHooks): () => void {
  const previous = hooks
  hooks = { ...hooks, ...next }
  return () => { hooks = previous }
}

function revealOnce(workspaceId: string, panelId: PanelId): boolean {
  const doc = documentStoreFor(workspaceId)?.getSnapshot()
  const state = clientStateFor(workspaceId)
  if (!doc || !state) return false
  const placement = placementOf(doc, panelId)
  if (!placement) return false
  state.setActiveTab(placement.stackId, panelId)
  if (isCanvasDock(placement.dock)) {
    const { canvasId, nodeId } = placement.dock
    const host = canvasPanelOf(doc, canvasId)
    const hostPlacement = host ? placementOf(doc, host.id) : null
    if (host && hostPlacement) state.setActiveTab(hostPlacement.stackId, host.id)
    state.setSelection(canvasId, [nodeId])
    if (host) state.pushIntent({ panelId: host.id, kind: CANVAS_REVEAL_INTENT, data: { nodeId, panelId } })
  }
  const windowId = windowOf(doc, panelId)
  if (windowId) hooks.showWindow?.(workspaceId, windowId)
  state.focus(panelId)
  return true
}

/** Brings a panel on screen and focuses it. With `retry`, waits briefly for
 *  a panel that is not in the document yet (just created elsewhere). */
export async function revealPanel(workspaceId: string, panelId: PanelId, options?: { retry?: boolean }): Promise<boolean> {
  await hooks.selectWorkspace?.(workspaceId)
  if (!options?.retry) return revealOnce(workspaceId, panelId)
  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt > 0) await new Promise<void>((resolve) => setTimeout(resolve, 50))
    if (revealOnce(workspaceId, panelId)) return true
  }
  return false
}
