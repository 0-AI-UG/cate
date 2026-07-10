// =============================================================================
// App Store — Zustand state for workspaces and panel management.
// Workspace metadata is delegated to the main process (source of truth).
// Canvas/panel state remains local to each renderer window.
//
// This is the directory-index barrel: `from '.../appStore'` resolves here, so
// the public surface (useAppStore, selectors, setupWorkspaceSync, the canvasAccess
// re-exports, WORKSPACE_COLORS, PanelPlacement/AppStore types, worktree-color
// helpers, awaitWorkspaceSync) must match the former single-file module exactly.
// =============================================================================

import { create } from 'zustand'
import { useStoreWithEqualityFn } from 'zustand/traditional'
import { shallow } from 'zustand/shallow'
import { arrayEqualBy } from '../selectorUtils'
import type { WorkspaceState, PanelState, RuntimePhase } from '../../../shared/types'
import type { CanvasOperations } from '../../lib/canvas/canvasBridge'
import { LOCAL_RUNTIME_ID } from '../../../main/runtime/locator'

import type { AppStore } from './types'
import { createWorkspaceSlice } from './workspaceSlice'
import { createPanelSlice } from './panelSlice'
import { createRemoteSlice } from './remoteSlice'
import { createWorktreeSlice } from './worktreeSlice'
import { createSyncSlice } from './syncSlice'

// --- Public type re-exports (byte-identical to the former module) ---
export type { CanvasOperations }
export type { PanelPlacement, AppStore } from './types'

// --- Public helper re-exports ---
export {
  WORKSPACE_COLORS,
  awaitWorkspaceSync,
  getWorktreeColorPalette,
  pickWorktreeColor,
} from './helpers'

export {
  ensureCanvasOpsForPanel,
  getActiveCanvasOps,
  getActiveCanvasPanelId,
  getWorkspaceCanvasPanelId,
  getWorkspaceCanvasStore,
  placementForActivePanel,
} from '../../lib/workspace/canvasAccess'
export { getCanvasOpsById } from '../../lib/workspace/canvasAccess'

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

export const useAppStore = create<AppStore>((set, get) => ({
  // --- State ---
  // Start empty — a default workspace is created during init only if no session is restored.
  workspaces: [],
  selectedWorkspaceId: '',
  localRuntimePhase: null,
  reloadEpochs: {},

  // --- Slices ---
  ...createWorkspaceSlice(set, get),
  ...createPanelSlice(set, get),
  ...createRemoteSlice(set, get),
  ...createWorktreeSlice(set, get),
  ...createSyncSlice(set, get),
}))

// -----------------------------------------------------------------------------
// Cross-window workspace sync — subscribe to main-process broadcasts
// -----------------------------------------------------------------------------

let workspaceSyncCleanup: (() => void) | null = null

export function setupWorkspaceSync(): () => void {
  if (workspaceSyncCleanup) return workspaceSyncCleanup

  const unsubscribe = window.electronAPI.onWorkspaceChanged((infos) => {
    useAppStore.getState().mergeWorkspaceInfos(infos)
  })

  // The cross-window panel union (onWindowPanelsChanged) is subscribed in
  // useWindowRuntime so EVERY window — not just main — receives it.

  // Reflect the live runtime phase on the matching workspace. This broadcast
  // is the authoritative writer once a workspace has a stored connection record
  // (runtimeId); the connect/ensure/reinstall actions only seed/finalize the
  // phase around their IPC calls. All writes funnel through the one setter so
  // the canonical field can't be set two different ways.
  const unsubscribeStatus = window.electronAPI.onRuntimeStatus((evt) => {
    const store = useAppStore.getState()
    // The LOCAL daemon is a singleton; its phase is global, not per-workspace.
    if (evt.runtimeId === LOCAL_RUNTIME_ID) {
      store.setLocalRuntimePhase(evt.phase)
      return
    }
    const target = store.workspaces.find(
      (ws) => ws.connection && ws.connection.kind !== 'local' && ws.connection.runtimeId === evt.runtimeId,
    )
    if (target) store.setWorkspaceRuntimePhase(target.id, evt.phase, evt.message ?? null)
  })

  // Seed the LOCAL phase once: the startup connect may have finished (or failed)
  // before this listener attached, so a live event alone could miss it. Subscribe
  // FIRST (above), then snapshot — and don't clobber a live event that already
  // landed (only seed while still unknown).
  void window.electronAPI
    .runtimeLocalStatus()
    .then((s) => {
      if (useAppStore.getState().localRuntimePhase === null) {
        useAppStore.getState().setLocalRuntimePhase(s.phase as RuntimePhase)
      }
    })
    .catch(() => { /* best-effort seed; live events still drive updates */ })

  workspaceSyncCleanup = () => {
    unsubscribe()
    unsubscribeStatus()
    workspaceSyncCleanup = null
  }

  return workspaceSyncCleanup
}

// -----------------------------------------------------------------------------
// Granular selectors
// -----------------------------------------------------------------------------

/** Returns the selected workspace. Uses shallow equality to avoid re-renders
 *  when unrelated workspaces change. */
export function useSelectedWorkspace(): WorkspaceState | undefined {
  return useStoreWithEqualityFn(
    useAppStore,
    (s) => s.workspaces.find((w) => w.id === s.selectedWorkspaceId),
    shallow,
  )
}

/** Returns just the panels record of the selected workspace. */
export function useWorkspacePanels(): Record<string, PanelState> | undefined {
  return useAppStore(
    (s) => s.workspaces.find((w) => w.id === s.selectedWorkspaceId)?.panels,
  )
}

/** Returns workspaces array, re-rendering on add/remove/reorder and metadata changes (name, color, rootPath). */
export function useWorkspaceList(): WorkspaceState[] {
  return useStoreWithEqualityFn(
    useAppStore,
    (s) => s.workspaces,
    (a, b) => arrayEqualBy(a, b, (x, y) =>
      x.id === y.id &&
      x.name === y.name &&
      x.color === y.color &&
      x.rootPath === y.rootPath &&
      x.rootPathError === y.rootPathError &&
      x.isRootPathPending === y.isRootPathPending &&
      x.runtime?.phase === y.runtime?.phase &&
      x.runtime?.error === y.runtime?.error,
    ),
  )
}
