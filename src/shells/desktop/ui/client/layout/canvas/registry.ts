// One canvas view store per open canvas, keyed by workspace and canvas id.
// A store lives while its workspace's document is open and its canvas exists;
// the drag layer, shortcuts and the e2e surface reach canvases through here.

import { clientStateFor, documentStoreFor, subscribeDocumentStores } from '@client/document'
import { createCanvasView, type CanvasViewStore } from './store'

let animate = true

/** Node enter/exit animations for stores created from now on. The e2e shell
 *  turns them off. */
export function setCanvasAnimations(enabled: boolean): void {
  animate = enabled
}

interface Entry {
  workspaceId: string
  canvasId: string
  store: CanvasViewStore
  stop: () => void
}

const entries = new Map<string, Entry>()
const key = (workspaceId: string, canvasId: string) => `${workspaceId}\u0000${canvasId}`
let watching = false

function release(entry: Entry): void {
  entries.delete(key(entry.workspaceId, entry.canvasId))
  entry.stop()
  entry.store.getState().dispose()
}

function watchStores(): void {
  if (watching) return
  watching = true
  subscribeDocumentStores(() => {
    for (const entry of [...entries.values()]) {
      if (!documentStoreFor(entry.workspaceId)) release(entry)
    }
  })
}

/** The view store of a canvas, created on first use. Null while the
 *  workspace's document is not open or has no such canvas. */
export function canvasViewFor(workspaceId: string, canvasId: string): CanvasViewStore | null {
  const existing = entries.get(key(workspaceId, canvasId))
  if (existing) return existing.store
  const document = documentStoreFor(workspaceId)
  if (!document || !document.getSnapshot().canvases[canvasId]) return null
  watchStores()
  const store = createCanvasView({
    workspaceId,
    canvasId,
    document,
    clientState: clientStateFor(workspaceId),
    animate,
  })
  // The canvas went with its canvas panel: drop the view.
  const stop = document.subscribe(() => {
    if (!document.getSnapshot().canvases[canvasId]) {
      const entry = entries.get(key(workspaceId, canvasId))
      if (entry) release(entry)
    }
  })
  entries.set(key(workspaceId, canvasId), { workspaceId, canvasId, store, stop })
  return store
}

/** Test hook: drops every view. */
export function resetCanvasViews(): void {
  for (const entry of [...entries.values()]) release(entry)
}
