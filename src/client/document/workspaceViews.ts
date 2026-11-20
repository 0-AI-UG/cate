// Remembered views belong to this device, never to the workspace runtime.
// The file layer debounces disk writes; send changes immediately so closing a
// workspace or reloading a renderer cannot strand a pending viewport timer.
import type { DeviceStore } from '@kernel/state/contract'
import type { ClientState, ClientStateStore, Viewport } from './clientState'

export const WORKSPACE_VIEWS_DOCUMENT = 'workspace-views'
type WorkspaceViews = Record<string, Record<string, Viewport>>

function normalize(raw: unknown): WorkspaceViews {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return Object.fromEntries(Object.entries(raw).map(([workspaceId, canvases]) => [
    workspaceId,
    Object.fromEntries(Object.entries(canvases && typeof canvases === 'object' && !Array.isArray(canvases) ? canvases : {}).flatMap(([id, value]) => {
      if (!value || typeof value !== 'object') return []
      const v = value as Viewport
      return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.zoom) && v.zoom > 0
        ? [[id, { x: v.x, y: v.y, zoom: v.zoom }]]
        : []
    })),
  ]))
}

export interface WorkspaceViewsStore {
  viewports(workspaceId: string): ClientState['viewports']
  remember(workspaceId: string, state: ClientStateStore): () => void
  dispose(): void
}

export async function loadWorkspaceViews(device: DeviceStore): Promise<WorkspaceViewsStore> {
  let views = normalize(await device.get(WORKSPACE_VIEWS_DOCUMENT).catch(() => undefined))
  // Other windows and hand edits update the persistence cache, without moving
  // a camera the person is currently using.
  const stop = device.subscribe(WORKSPACE_VIEWS_DOCUMENT, (raw) => { views = normalize(raw) })
  return {
    viewports: (workspaceId) => views[workspaceId] ?? {},
    remember(workspaceId, state) {
      let previous = state.getSnapshot().viewports
      return state.subscribe(() => {
        const next = state.getSnapshot().viewports
        if (next === previous) return
        // Only overlay cameras changed here; another window may have saved
        // other canvases since this client opened the workspace.
        const changed = Object.fromEntries(Object.entries(next).filter(([id, viewport]) => viewport !== previous[id]))
        previous = next
        views = { ...views, [workspaceId]: { ...views[workspaceId], ...changed } }
        void device.set(WORKSPACE_VIEWS_DOCUMENT, views).catch(() => {})
      })
    },
    dispose: stop,
  }
}
