// =============================================================================
// App Store — workspace lifecycle slice (add/select/remove/rename/reorder etc.)
// =============================================================================

import log from '../../lib/logger'
import { ALL_ZONES } from '../../../shared/types'
import type { AppSet, AppGet, AppStoreActions } from './types'
import { isRemoteRuntimeConnection } from '../../../shared/runtimeConnection'
import {
  createDefaultWorkspace,
  syncCreateToMain,
  syncRemoveFromMain,
  syncUpdateToMain,
  applyWorkspaceInfo,
  hydrateWorkspaceFromDisk,
} from './helpers'
import { releaseCanvasStoreForPanel } from '../canvasStore'
import {
  getOrCreateWorkspaceDockStore,
  releaseWorkspaceDockStore,
} from '../../lib/workspace/dockRegistry'
import {
  getWorkspaceCanvasPanelId,
} from '../../lib/workspace/canvasAccess'
import { setActivePanel } from '../../lib/activePanel'
import { terminalRegistry } from '../../lib/terminal/terminalRegistry'
import { deferredSnapshots, restoreDeferredWorkspace } from '../../lib/workspace/deferredRestore'

type WorkspaceSliceActions = Pick<
  AppStoreActions,
  | 'addWorkspace'
  | 'selectWorkspace'
  | 'switchWorkspaceByOffset'
  | 'removeWorkspace'
  | 'ensureCenterCanvas'
  | 'setWorkspaceColor'
  | 'renameWorkspace'
  | 'reorderWorkspaces'
  | 'addAdditionalRoot'
  | 'removeAdditionalRoot'
  | 'getWorkspace'
  | 'selectedWorkspace'
>

/** Resolve the workspace `offset` steps away from `currentId` in list order,
 *  wrapping around both ends. Returns null when switching is a no-op: fewer than
 *  two workspaces, or `currentId` isn't in the list. Ordering follows the
 *  `workspaces` array — the same order the sidebar renders. */
export function workspaceIdAtOffset(
  workspaces: readonly { id: string }[],
  currentId: string,
  offset: number,
): string | null {
  if (workspaces.length < 2) return null
  const currentIndex = workspaces.findIndex((w) => w.id === currentId)
  if (currentIndex === -1) return null
  const len = workspaces.length
  const nextIndex = (((currentIndex + offset) % len) + len) % len
  return workspaces[nextIndex].id
}

export function createWorkspaceSlice(set: AppSet, get: AppGet): WorkspaceSliceActions {
  return {
    addWorkspace(name?, rootPath?, id?, connection?) {
      // Reusing a stable id (session restore) must not be blocked by the cap and
      // must never create a second entry for an id that already exists — both
      // would resurrect the "duplicate workspaces on reload" bug.
      if (id) {
        const existing = get().workspaces.find((w) => w.id === id)
        if (existing) return existing.id
      }
      const existingCount = get().workspaces.length
      if (!id && existingCount >= 10) {
        // Cap at 10 workspaces — no-op, return current selection
        return get().selectedWorkspaceId || get().workspaces[0]?.id || ''
      }
      const ws = createDefaultWorkspace(name, rootPath, id, connection)

      // Note: the new workspace starts with an empty panels map and its own (empty)
      // dock + canvas stores. ensureCenterCanvas mints a fresh canvas panel for the
      // center zone when the workspace is shown. Copying panels from another
      // workspace here led to orphaned/duplicate canvas panels and the "empty pane"
      // bug.

      set((state) => ({
        workspaces: [...state.workspaces, ws],
        // Auto-select if this is the first workspace
        selectedWorkspaceId: state.workspaces.length === 0 ? ws.id : state.selectedWorkspaceId,
      }))
      // Sync to main process
      syncCreateToMain(ws).then((result) => {
        if (!result) return
        if (!result.ok) {
          log.warn('[workspace-sync] Create rejected:', result.error.message)
          const conflictingId = result.error.conflictingWorkspaceId
          if (ws.rootPath) {
            window.electronAPI.recentProjectsRemove(ws.rootPath).catch((err) =>
              log.warn('[workspace] Failed to remove rejected project from recents:', err),
            )
          }
          // Never leave an optimistic workspace that main refused to register:
          // it has no allowed-root grant and cannot safely own panels or saves.
          if (get().workspaces.some((candidate) => candidate.id === ws.id)) {
            get().removeWorkspace(ws.id)
          }
          if (conflictingId && get().workspaces.some((candidate) => candidate.id === conflictingId)) {
            void get().selectWorkspace(conflictingId)
          }
          return
        }
        set((state) => ({
          workspaces: state.workspaces.map((candidate) => (
            candidate.id === ws.id ? applyWorkspaceInfo(candidate, result.workspace) : candidate
          )),
        }))
      })
      return ws.id
    },

    async selectWorkspace(id) {
      const state = get()
      if (state.selectedWorkspaceId === id) {
        // Already selected — normally a no-op. But addWorkspace auto-selects the
        // first workspace on restore, so the restore's selectWorkspace(firstId)
        // would otherwise skip the runtime connect entirely, leaving a remote
        // workspace stuck with no phase (a permanent "connecting" lock) and every
        // runtime op failing with "No runtime registered". Kick off the
        // connect here so the restore's awaited selectWorkspace still resolves
        // only once the runtime is live.
        const current = state.workspaces.find((w) => w.id === id)
        if (isRemoteRuntimeConnection(current?.connection) && !current.runtime) {
          await get().ensureWorkspaceRuntime(id)
        }
        // A startup-deferred snapshot restores here too: addWorkspace auto-selects
        // the first workspace, so the selected (e.g. remote) workspace's
        // selectWorkspace call lands on THIS already-selected path, not the main
        // one below. Mirror the deferred-restore handling so it isn't skipped.
        if (deferredSnapshots.has(id)) {
          try {
            await restoreDeferredWorkspace(id)
          } catch (error) {
            log.error('Failed to restore deferred workspace:', error)
          }
        } else if (current && Object.keys(current.panels).length === 0) {
          // Reopening an already-selected, never-activated workspace: pull its
          // on-disk layout in. Anything already activated — even one cleared via
          // Close Panels — is left as-is, so a re-select never resurrects it.
          await hydrateWorkspaceFromDisk(id)
        }
        return
      }

      // No snapshot-back is needed on switch-away: each workspace owns its dock +
      // canvas stores and those stores SURVIVE a switch (they're released only on
      // close/remove). The live stores stay the source of truth and the save path
      // serializes straight from them via the canvasAccess resolvers.

      // Discard outgoing workspace if it was never initialized (no folder
      // picked, not currently picking one). Keeps stray "Add Workspace" rows
      // from accumulating in the sidebar.
      const outgoing = state.workspaces.find((w) => w.id === state.selectedWorkspaceId)
      const shouldDropOutgoing =
        !!outgoing && !outgoing.rootPath && !outgoing.isRootPathPending && outgoing.id !== id

      // Switch selection. The shell is keyed by selectedWorkspaceId, so it
      // remounts and reads the incoming workspace's OWN dock + canvas stores —
      // there is no shared store to overwrite, so content cannot bleed across
      // workspaces even if a restore is still in flight.
      set({ selectedWorkspaceId: id })
      const incomingCanvasPanelId = getWorkspaceCanvasPanelId(id)
      if (incomingCanvasPanelId) {
        // Point the canonical active panel at the incoming canvas so canvas
        // shortcuts route here AND a stack the user last touched in the OTHER
        // workspace can't attract new panels created in this one.
        setActivePanel(incomingCanvasPanelId)
      }

      // Reconnect a remote workspace's runtime if it isn't live (e.g. after a
      // restart / restore). For a REMOTE workspace we must AWAIT this before the
      // deferred restore below, because that creates terminals and reads files
      // that route through the runtime — racing the async reconnect would hit
      // an unregistered runtime and throw. Local workspaces stay synchronous.
      const incoming = get().workspaces.find((w) => w.id === id)
      if (isRemoteRuntimeConnection(incoming?.connection)) {
        const ok = await get().ensureWorkspaceRuntime(id)
        if (!ok) {
          log.warn('[runtime] reconnect failed for workspace %s; restore will surface the error', id)
        }
      }

      if (shouldDropOutgoing && outgoing) {
        get().removeWorkspace(outgoing.id)
      }

      // First activation of a workspace restored from disk: replay its snapshot
      // into its own stores. restoreDeferredWorkspace addresses the workspace by
      // id, so a concurrent switch can never redirect it into another workspace.
      if (deferredSnapshots.has(id)) {
        try {
          await restoreDeferredWorkspace(id)
        } catch (error) {
          log.error('Failed to restore deferred workspace:', error)
        }
      } else if (Object.keys(get().workspaces.find((w) => w.id === id)?.panels ?? {}).length === 0) {
        // Opening a never-activated workspace that has a rootPath — the
        // close-then-reopen path (onOpenPath addWorkspace(name, rootPath) → select).
        // Load its saved .cate/ layout. Runs after the runtime reconnect above so
        // a remote read can't race an unregistered runtime. The zero-panel gate
        // keeps a plain switch-back from reloading a workspace cleared via Close
        // Panels. Guarded + idempotent inside the helper.
        await hydrateWorkspaceFromDisk(id)
      }

      // Guarantee the center zone has a canvas panel — a brand new workspace, or
      // a restored dock layout that referenced no canvas-type panel.
      if (get().workspaces.some((w) => w.id === id)) {
        get().ensureCenterCanvas(id)
      }
    },

    ensureCenterCanvas(workspaceId) {
      const ws = get().workspaces.find((w) => w.id === workspaceId)
      if (!ws) return
      const dockStore = getOrCreateWorkspaceDockStore(workspaceId)
      const dockState = dockStore.getState()

      // Collect panel IDs referenced by any dock zone
      const walk = (
        node: import('../../../shared/types').DockLayoutNode,
        out: Set<string>,
      ) => {
        if (node.type === 'tabs') node.panelIds.forEach((id) => out.add(id))
        else node.children.forEach((c) => walk(c, out))
      }
      const allDockPanelIds = new Set<string>()
      for (const zoneName of ALL_ZONES) {
        const zone = dockState.zones[zoneName]
        if (zone.layout) walk(zone.layout, allDockPanelIds)
      }

      // Sweep orphaned canvas panels (in ws.panels but not in any dock zone).
      // These accumulate when session restore or dock resets leave stale
      // canvas entries behind — the sidebar would then show phantom canvases.
      const orphanedCanvasIds = Object.values(ws.panels)
        .filter((p) => p.type === 'canvas' && !allDockPanelIds.has(p.id))
        .map((p) => p.id)

      if (orphanedCanvasIds.length > 0) {
        for (const id of orphanedCanvasIds) {
          try { releaseCanvasStoreForPanel(id) } catch { /* ignore */ }
        }
        set((state) => ({
          workspaces: state.workspaces.map((w) => {
            if (w.id !== workspaceId) return w
            const panels = { ...w.panels }
            for (const id of orphanedCanvasIds) delete panels[id]
            return { ...w, panels }
          }),
        }))
      }

      // Sweep orphaned dock tabs (in some dock zone but not in ws.panels). These
      // appear after a panel state was dropped without the dock layout being
      // updated — e.g. closeAllPanels wiping ws.panels, or a stale snapshot
      // restore — and render as a generic "Panel" tab with the editor icon.
      const orphanedDockIds = Array.from(allDockPanelIds).filter((id) => !ws.panels[id])
      if (orphanedDockIds.length > 0) {
        for (const id of orphanedDockIds) {
          try { dockStore.getState().undockPanel(id) } catch { /* ignore */ }
        }
      }

      // Check if the center zone now contains a canvas-type panel
      const centerPanelIds: string[] = []
      const center = dockStore.getState().zones.center
      if (center.layout) {
        const c = new Set<string>()
        walk(center.layout, c)
        centerPanelIds.push(...c)
      }
      const wsAfter = get().workspaces.find((w) => w.id === workspaceId)
      const hasCanvas = centerPanelIds.some((pid) => wsAfter?.panels[pid]?.type === 'canvas')
      if (!hasCanvas) {
        get().createCanvas(workspaceId)
      }
    },

    removeWorkspace(id, forgetRecent = false) {
      // When the user explicitly closes a workspace, also forget its project so it
      // doesn't reappear on next launch (issue #220). Opt-in: the default keeps
      // recents intact for non-user removals (session-restore teardown, dropping
      // an uninitialized stray workspace). Capture the rootPath before we mutate.
      if (forgetRecent) {
        const closing = get().workspaces.find((w) => w.id === id)
        if (closing?.rootPath) {
          window.electronAPI.recentProjectsRemove(closing.rootPath).catch((err) =>
            log.warn('[workspace] Failed to remove from recent projects:', err),
          )
        }
      }
      // Clean up deferred snapshot if workspace was never switched to
      deferredSnapshots.delete(id)
      // Dispose terminals + clear the workspace's stores before removing it.
      get().closeAllPanels(id)
      // Drop the workspace's isolated stores so they can't linger or be reused.
      // Read the canvas panels AFTER closeAllPanels (it mints a fresh center
      // canvas) so the minted store is released too.
      for (const panel of Object.values(get().workspaces.find((w) => w.id === id)?.panels ?? {})) {
        if (panel.type === 'canvas') {
          try { releaseCanvasStoreForPanel(panel.id) } catch { /* ignore */ }
        }
      }
      releaseWorkspaceDockStore(id)
      terminalRegistry.disposeWorkspace(id)

      const wasSelected = get().selectedWorkspaceId === id

      set((state) => {
        const remaining = state.workspaces.filter((w) => w.id !== id)
        if (remaining.length === 0) {
          // Always keep at least one workspace
          const fresh = createDefaultWorkspace()
          syncCreateToMain(fresh)
          return {
            workspaces: [fresh],
            selectedWorkspaceId: fresh.id,
          }
        }
        const newSelected =
          state.selectedWorkspaceId === id ? remaining[0].id : state.selectedWorkspaceId
        return {
          workspaces: remaining,
          selectedWorkspaceId: newSelected,
        }
      })

      // If the removed workspace was selected, the shell remounts onto the new
      // selection and reads ITS own stores — nothing to copy. Just make sure the
      // newly-selected workspace's center zone has a canvas panel.
      if (wasSelected) {
        const newId = get().selectedWorkspaceId
        if (get().workspaces.some((w) => w.id === newId)) {
          get().ensureCenterCanvas(newId)
        }
      }

      // Sync to main process
      syncRemoveFromMain(id)
    },

    async switchWorkspaceByOffset(offset) {
      const state = get()
      const targetId = workspaceIdAtOffset(state.workspaces, state.selectedWorkspaceId, offset)
      if (targetId) await get().selectWorkspace(targetId)
    },

    getWorkspace(id) {
      return get().workspaces.find((w) => w.id === id)
    },

    selectedWorkspace() {
      return get().workspaces.find((w) => w.id === get().selectedWorkspaceId)
    },

    setWorkspaceColor(wsId, color) {
      set((state) => ({
        workspaces: state.workspaces.map((ws) =>
          ws.id === wsId ? { ...ws, color } : ws,
        ),
      }))
      syncUpdateToMain(wsId, { color })
    },

    renameWorkspace(wsId, name) {
      const trimmed = name.trim()
      if (!trimmed) return
      set((state) => ({
        workspaces: state.workspaces.map((ws) =>
          ws.id === wsId ? { ...ws, name: trimmed } : ws,
        ),
      }))
      syncUpdateToMain(wsId, { name: trimmed })
    },

    reorderWorkspaces(fromIndex, toIndex) {
      // `toIndex` is an insertion slot in [0, length]: 0 = before the first row,
      // length = after the last. Dropping at the item's own slot or the one just
      // after it leaves the order unchanged.
      set((state) => {
        if (toIndex === fromIndex || toIndex === fromIndex + 1) return state
        const workspaces = [...state.workspaces]
        const [moved] = workspaces.splice(fromIndex, 1)
        // Removing the dragged item first shifts every later slot down by one, so
        // for downward moves the insertion slot is one less than requested.
        const insertAt = fromIndex < toIndex ? toIndex - 1 : toIndex
        workspaces.splice(insertAt, 0, moved)
        return { workspaces }
      })
    },

    addAdditionalRoot(wsId, rootPath) {
      set((state) => ({
        workspaces: state.workspaces.map((ws) => {
          if (ws.id !== wsId) return ws
          const current = ws.additionalRoots ?? []
          // Don't add duplicates or the primary root itself.
          if (rootPath === ws.rootPath || current.includes(rootPath)) return ws
          return { ...ws, additionalRoots: [...current, rootPath] }
        }),
      }))
    },

    removeAdditionalRoot(wsId, rootPath) {
      set((state) => ({
        workspaces: state.workspaces.map((ws) => {
          if (ws.id !== wsId) return ws
          const current = ws.additionalRoots ?? []
          return { ...ws, additionalRoots: current.filter((p) => p !== rootPath) }
        }),
      }))
    },
  }
}
