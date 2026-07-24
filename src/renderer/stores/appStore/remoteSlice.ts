// =============================================================================
// App Store — remote workspace + runtime lifecycle slice.
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
import { ensureProjectTrusted } from '../workspaceTrustStore'

type RemoteSliceActions = Pick<
  AppStoreActions,
  | 'setWorkspaceRootPath'
  | 'connectRemoteWorkspace'
  | 'ensureWorkspaceRuntime'
  | 'retryRuntime'
  | 'installRuntime'
  | 'deleteRuntime'
  | 'setWorkspaceRuntimePhase'
  | 'setLocalRuntimePhase'
>

export function createRemoteSlice(set: AppSet, get: AppGet): RemoteSliceActions {
  return {
    async setWorkspaceRootPath(wsId, rootPath) {
      const ws = get().workspaces.find((w) => w.id === wsId)
      if (!ws) return false

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
        return false
      }

      // The trust gate, on the one path that turns a folder into an open local
      // workspace. Declining means the workspace stays where it was — nothing in
      // the folder is read and no panel from its layout is restored.
      // (Checked after the duplicate redirect: an already-open folder is one the
      // user has already vouched for, so re-asking would be noise.)
      if (!(await ensureProjectTrusted(rootPath))) return false

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
              candidate.id === wsId && candidate.rootPath === rootPath
                ? {
                    ...candidate,
                    rootPath: ws.rootPath,
                    name: ws.name,
                    isRootPathPending: false,
                    rootPathError: message,
                  }
                : candidate
            )),
          }))
          const conflictingId = result?.error?.conflictingWorkspaceId
          if (conflictingId && get().workspaces.some((candidate) => candidate.id === conflictingId)) {
            void get().selectWorkspace(conflictingId)
          }
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

    setWorkspaceRuntimePhase(wsId, phase, error) {
      const clean = error == null ? null : errorMessage(error)
      set((state) => ({
        workspaces: state.workspaces.map((c) =>
          c.id === wsId ? { ...c, runtime: { phase, ...(clean != null ? { error: clean } : {}) } } : c,
        ),
      }))
    },

    setLocalRuntimePhase(phase) {
      set({ localRuntimePhase: phase })
    },

    async connectRemoteWorkspace(wsId, spec) {
      const ws = get().workspaces.find((w) => w.id === wsId)
      if (!ws) return false
      let res
      try {
        res = await window.electronAPI.runtimeConnect(spec)
      } catch (err) {
        log.warn('[runtime] connect failed:', err instanceof Error ? err.message : String(err))
        return false
      }
      if (!res?.ok) {
        log.warn('[runtime] connect failed:', res?.error ?? 'unknown')
        return false
      }

      // Same gate as the local open. The locator only exists once the runtime
      // has answered, so this is the earliest point we can ask — but it is still
      // before anything is read out of the remote repo's `.cate/`.
      if (!(await ensureProjectTrusted(res.rootPath))) return false

      const label = spec.kind === 'wsl' ? `${spec.distro}` : `${spec.user}@${spec.host}`
      const desiredName = ws.name === 'Workspace' ? label : ws.name
      // Store rootPath + connection FIRST so the probe's RUNTIME_STATUS phases
      // (keyed by runtimeId) can match this workspace.
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
        set((state) => ({
          workspaces: state.workspaces.map((candidate) => (
            candidate.id === wsId && candidate.rootPath === res.rootPath
              ? { ...candidate, rootPath: ws.rootPath, name: ws.name }
              : candidate
          )),
        }))
        const conflictingId = result?.error?.conflictingWorkspaceId
        if (conflictingId && get().workspaces.some((candidate) => candidate.id === conflictingId)) {
          void get().selectWorkspace(conflictingId)
        }
        log.warn('[runtime] register failed:', result?.error?.message ?? 'unknown')
        return false
      }
      set((state) => ({
        workspaces: state.workspaces.map((c) => (c.id === wsId ? applyWorkspaceInfo(c, result.workspace) : c)),
      }))
      // Probe to drive the phase. Main reports connected / missing / unreachable;
      // we never set the phase ourselves. (A fresh remote with no daemon lands in
      // 'missing' → the canvas lock offers Install.)
      await get().ensureWorkspaceRuntime(wsId)
      // Runtime is live now, so its .cate/ (next to the remote repo) is
      // readable: load any saved layout for a reconnected workspace. Awaited so a
      // caller that then spawns a terminal does so only after the restore.
      await hydrateWorkspaceFromDisk(wsId)
      return true
    },

    async ensureWorkspaceRuntime(wsId) {
      const ws = get().workspaces.find((w) => w.id === wsId)
      if (!ws?.connection || ws.connection.kind === 'local') return true
      // Probe only. The phase (connecting → connected | missing | unreachable) is
      // emitted by the main process and lands via the RUNTIME_STATUS broadcast.
      // No client-side phase logic. Returns whether the runtime is now live.
      try {
        const res = await window.electronAPI.runtimeEnsure(ws.connection)
        return !!res?.ok
      } catch (err) {
        log.warn('[runtime] ensure failed:', err instanceof Error ? err.message : String(err))
        return false
      }
    },

    // The "Retry"/"Reconnect" actions (lock overlay, terminal create failure).
    // Remote/WSL: re-probe the stored connection. LOCAL: relaunch the built-in
    // daemon — the only recovery when its startup connect failed (nothing else
    // re-runs it, so without this a local failure was dead until app restart).
    async retryRuntime(wsId) {
      const ws = get().workspaces.find((w) => w.id === wsId)
      if (ws?.connection && ws.connection.kind !== 'local') {
        return get().ensureWorkspaceRuntime(wsId)
      }
      try {
        const res = await window.electronAPI.runtimeRetryLocal()
        return !!res?.ok
      } catch (err) {
        log.warn('[runtime] local retry failed:', err instanceof Error ? err.message : String(err))
        return false
      }
    },

    async installRuntime(wsId) {
      const ws = get().workspaces.find((w) => w.id === wsId)
      if (!ws?.connection || ws.connection.kind === 'local') return false
      try {
        const res = await window.electronAPI.runtimeInstall(ws.connection)
        return !!res?.ok
      } catch (err) {
        log.warn('[runtime] install failed:', err instanceof Error ? err.message : String(err))
        return false
      }
    },

    async deleteRuntime(wsId) {
      const ws = get().workspaces.find((w) => w.id === wsId)
      if (!ws?.connection || ws.connection.kind === 'local') return false
      try {
        // Main rm -rf's the host install and drives the phase to 'missing'.
        const res = await window.electronAPI.runtimeDelete(ws.connection)
        return !!res?.ok
      } catch (err) {
        log.warn('[runtime] delete failed:', err instanceof Error ? err.message : String(err))
        return false
      }
    },
  }
}
