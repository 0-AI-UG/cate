// =============================================================================
// App Store — remote workspace + companion lifecycle slice.
// =============================================================================

import log from '../../lib/logger'
import { errorMessage } from '../../lib/errorMessage'
import type { AppSet, AppGet, AppStoreActions } from './types'
import {
  syncUpdateToMain,
  applyWorkspaceInfo,
  hydrateWorkspaceFromDisk,
} from './helpers'
import { workspaceDisplayName } from '../../lib/fs/displayPath'

type RemoteSliceActions = Pick<
  AppStoreActions,
  | 'setWorkspaceRootPath'
  | 'connectRemoteWorkspace'
  | 'ensureWorkspaceCompanion'
  | 'retryCompanion'
  | 'installCompanion'
  | 'deleteCompanion'
  | 'setWorkspaceCompanionPhase'
  | 'setLocalCompanionPhase'
>

export function createRemoteSlice(set: AppSet, get: AppGet): RemoteSliceActions {
  return {
    setWorkspaceRootPath(wsId, rootPath) {
      const ws = get().workspaces.find((w) => w.id === wsId)
      if (!ws) return Promise.resolve(false)

      // Don't open the same folder twice in this instance. Two tabs on one root
      // would share its .cate/workspace.json + session.json and clobber each
      // other's autosave. The project lock can't catch this — it's keyed on pid,
      // so two tabs in the SAME process always re-acquire it. Redirect to the
      // workspace that already has this folder instead of duplicating it. (Main
      // backstops this with a DUPLICATE_ROOT check on the resolved path, below.)
      const duplicate = get().workspaces.find((w) => w.id !== wsId && w.rootPath === rootPath)
      if (duplicate) {
        // Just focus the existing one. selectWorkspace already discards a
        // never-rooted outgoing tab on switch, so the empty workspace we were
        // about to fill is cleaned up; an already-rooted one is left untouched.
        get().selectWorkspace(duplicate.id)
        return Promise.resolve(false)
      }

      const folderName = workspaceDisplayName(rootPath) || rootPath
      const desiredName = ws.name === 'Workspace' ? folderName : ws.name
      // Apply optimistically so any panel created synchronously after this call
      // (e.g. WelcomePage spawning a terminal right after picking a folder)
      // sees the new rootPath and uses it as cwd instead of falling back to $HOME.
      set((state) => ({
        workspaces: state.workspaces.map((candidate) => {
          if (candidate.id !== wsId) return candidate
          return {
            ...candidate,
            rootPath,
            name: desiredName,
            isRootPathPending: true,
            rootPathError: null,
          }
        }),
      }))
      return syncUpdateToMain(wsId, { rootPath, name: desiredName }).then((result) => {
        if (!result?.ok) {
          const message = errorMessage(result?.error, 'Failed to update workspace root')
          set((state) => ({
            workspaces: state.workspaces.map((candidate) => (
              candidate.id === wsId
                ? { ...candidate, isRootPathPending: false, rootPathError: message }
                : candidate
            )),
          }))
          log.warn('[workspace-sync] Update rejected:', message)
          return false
        }
        set((state) => ({
          workspaces: state.workspaces.map((candidate) => (
            candidate.id === wsId
              ? applyWorkspaceInfo(candidate, result.workspace)
              : candidate
          )),
        }))
        window.electronAPI.recentProjectsAdd(result.workspace.rootPath)
        // Just pointed a (local) workspace at a folder — load its saved .cate/
        // layout if it has one. Awaited so a caller that then spawns a terminal
        // does so only after any restore (matching app-startup ordering).
        return hydrateWorkspaceFromDisk(wsId).then(() => true)
      })
    },

    setWorkspaceCompanionPhase(wsId, phase, error) {
      const clean = error == null ? null : errorMessage(error)
      set((state) => ({
        workspaces: state.workspaces.map((c) =>
          c.id === wsId ? { ...c, companion: { phase, ...(clean != null ? { error: clean } : {}) } } : c,
        ),
      }))
    },

    setLocalCompanionPhase(phase) {
      set({ localCompanionPhase: phase })
    },

    async connectRemoteWorkspace(wsId, spec) {
      const ws = get().workspaces.find((w) => w.id === wsId)
      if (!ws) return false
      let res
      try {
        res = await window.electronAPI.companionConnect(spec)
      } catch (err) {
        log.warn('[companion] connect failed:', err instanceof Error ? err.message : String(err))
        return false
      }
      if (!res?.ok) {
        log.warn('[companion] connect failed:', res?.error ?? 'unknown')
        return false
      }

      const label = spec.kind === 'wsl' ? `${spec.distro}` : `${spec.user}@${spec.host}`
      const desiredName = ws.name === 'Workspace' ? label : ws.name
      // Store rootPath + connection FIRST so the probe's COMPANION_STATUS phases
      // (keyed by companionId) can match this workspace.
      set((state) => ({
        workspaces: state.workspaces.map((c) =>
          c.id === wsId ? { ...c, rootPath: res!.rootPath, name: desiredName } : c,
        ),
      }))
      const result = await syncUpdateToMain(wsId, {
        rootPath: res.rootPath,
        name: desiredName,
        connection: res.connection,
      })
      if (!result?.ok) {
        log.warn('[companion] register failed:', result?.error?.message ?? 'unknown')
        return false
      }
      set((state) => ({
        workspaces: state.workspaces.map((c) => (c.id === wsId ? applyWorkspaceInfo(c, result.workspace) : c)),
      }))
      // Probe to drive the phase. Main reports connected / missing / unreachable;
      // we never set the phase ourselves. (A fresh remote with no daemon lands in
      // 'missing' → the canvas lock offers Install.)
      await get().ensureWorkspaceCompanion(wsId)
      // Companion is live now, so its .cate/ (next to the remote repo) is
      // readable: load any saved layout for a reconnected workspace. Awaited so a
      // caller that then spawns a terminal does so only after the restore.
      await hydrateWorkspaceFromDisk(wsId)
      return true
    },

    async ensureWorkspaceCompanion(wsId) {
      const ws = get().workspaces.find((w) => w.id === wsId)
      if (!ws?.connection || ws.connection.kind === 'local') return true
      // Probe only. The phase (connecting → connected | missing | unreachable) is
      // emitted by the main process and lands via the COMPANION_STATUS broadcast.
      // No client-side phase logic. Returns whether the companion is now live.
      try {
        const res = await window.electronAPI.companionEnsure(ws.connection)
        return !!res?.ok
      } catch (err) {
        log.warn('[companion] ensure failed:', err instanceof Error ? err.message : String(err))
        return false
      }
    },

    // The lock overlay's "Retry"/"Reconnect" — re-probe the existing connection.
    async retryCompanion(wsId) {
      return get().ensureWorkspaceCompanion(wsId)
    },

    async installCompanion(wsId) {
      const ws = get().workspaces.find((w) => w.id === wsId)
      if (!ws?.connection || ws.connection.kind === 'local') return false
      try {
        const res = await window.electronAPI.companionInstall(ws.connection)
        return !!res?.ok
      } catch (err) {
        log.warn('[companion] install failed:', err instanceof Error ? err.message : String(err))
        return false
      }
    },

    async deleteCompanion(wsId) {
      const ws = get().workspaces.find((w) => w.id === wsId)
      if (!ws?.connection || ws.connection.kind === 'local') return false
      try {
        // Main rm -rf's the host install and drives the phase to 'missing'.
        const res = await window.electronAPI.companionDelete(ws.connection)
        return !!res?.ok
      } catch (err) {
        log.warn('[companion] delete failed:', err instanceof Error ? err.message : String(err))
        return false
      }
    },
  }
}
