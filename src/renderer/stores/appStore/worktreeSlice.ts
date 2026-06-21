// =============================================================================
// App Store — git worktree registry slice (see ParallelWorkTab.tsx).
// =============================================================================

import type { WorktreeMeta } from '../../../shared/types'
import { pathKey } from '../../../shared/pathUtils'
import type { AppSet, AppGet, AppStoreActions } from './types'
import { pickWorktreeColor, setPanelField } from './helpers'
import { terminalRegistry } from '../../lib/terminal/terminalRegistry'
import { useSettingsStore } from '../settingsStore'

type WorktreeSliceActions = Pick<
  AppStoreActions,
  | 'ensurePrimaryWorktree'
  | 'hydrateWorktrees'
  | 'upsertWorktree'
  | 'removeWorktree'
  | 'setWorktreeColor'
  | 'setWorktreeLabel'
  | 'setPanelWorktreeId'
  | 'respawnPanelTerminal'
>

export function createWorktreeSlice(set: AppSet, get: AppGet): WorktreeSliceActions {
  return {
    ensurePrimaryWorktree(wsId) {
      set((state) => ({
        workspaces: state.workspaces.map((ws) => {
          if (ws.id !== wsId) return ws
          if (!ws.rootPath) return ws
          const list = ws.worktrees ?? []
          // The primary worktree is whichever record is keyed by the workspace's
          // own rootPath; isPrimary is derived from git at read time, so we only
          // need a UI-metadata record (id/color) to exist for that path.
          if (list.some((w) => w.path === ws.rootPath)) return ws
          const primary: WorktreeMeta = {
            id: `wt-primary-${ws.id}`,
            path: ws.rootPath,
            color: pickWorktreeColor(list),
          }
          return { ...ws, worktrees: [primary, ...list] }
        }),
      }))
    },

    hydrateWorktrees(wsId, persisted) {
      if (persisted.length === 0) return
      set((state) => ({
        workspaces: state.workspaces.map((ws) => {
          if (ws.id !== wsId) return ws
          // Merge by path so the persisted color/label/id wins over anything a
          // background sync already created for the same checkout, while keeping
          // any live worktree the saved session didn't know about. Key on the
          // normalized path so a separator/case mismatch (forward-slash git paths
          // vs native-separator stored paths on Windows) can't split one checkout
          // into two entries and defeat the precedence.
          const byPath = new Map((ws.worktrees ?? []).map((w) => [pathKey(w.path), w]))
          for (const w of persisted) byPath.set(pathKey(w.path), w)
          return { ...ws, worktrees: [...byPath.values()] }
        }),
      }))
    },

    upsertWorktree(wsId, wt) {
      set((state) => ({
        workspaces: state.workspaces.map((ws) => {
          if (ws.id !== wsId) return ws
          const list = ws.worktrees ?? []
          const idx = list.findIndex((w) => w.id === wt.id)
          const next = idx >= 0
            ? list.map((w) => (w.id === wt.id ? { ...w, ...wt } : w))
            : [...list, wt]
          return { ...ws, worktrees: next }
        }),
      }))
    },

    removeWorktree(wsId, worktreeId) {
      // Optionally destroy the worktree's terminal/agent panels (PTYs killed,
      // pi sessions disposed) before we drop the worktree record. Done outside
      // the set() updater because closePanel runs its own teardown + set().
      if (useSettingsStore.getState().closeWorktreePanelsOnDelete) {
        const ws = get().workspaces.find((w) => w.id === wsId)
        const doomed = Object.values(ws?.panels ?? {}).filter(
          (p) => p.worktreeId === worktreeId && (p.type === 'terminal' || p.type === 'agent'),
        )
        for (const p of doomed) get().closePanel(wsId, p.id)
      }
      set((state) => ({
        workspaces: state.workspaces.map((ws) => {
          if (ws.id !== wsId) return ws
          const list = (ws.worktrees ?? []).filter((w) => w.id !== worktreeId)
          // Strip the worktreeId from any panel still tagged with it (editors,
          // browsers, or all panels when the close-on-delete setting is off).
          const panels = Object.fromEntries(
            Object.entries(ws.panels).map(([id, p]) => [
              id,
              p.worktreeId === worktreeId ? { ...p, worktreeId: undefined } : p,
            ]),
          )
          return { ...ws, worktrees: list, panels }
        }),
      }))
    },

    setWorktreeColor(wsId, worktreeId, color) {
      set((state) => ({
        workspaces: state.workspaces.map((ws) => {
          if (ws.id !== wsId) return ws
          const list = (ws.worktrees ?? []).map((w) =>
            w.id === worktreeId ? { ...w, color } : w,
          )
          return { ...ws, worktrees: list }
        }),
      }))
    },

    setWorktreeLabel(wsId, worktreeId, label) {
      const trimmed = label?.trim()
      set((state) => ({
        workspaces: state.workspaces.map((ws) => {
          if (ws.id !== wsId) return ws
          const list = (ws.worktrees ?? []).map((w) =>
            w.id === worktreeId ? { ...w, label: trimmed || undefined } : w,
          )
          return { ...ws, worktrees: list }
        }),
      }))
    },

    setPanelWorktreeId(wsId, panelId, worktreeId) {
      setPanelField(set, wsId, panelId, (panel) => ({ ...panel, worktreeId }))
    },

    respawnPanelTerminal(wsId, panelId, cwd, worktreeId) {
      // Kill the existing PTY/xterm; TerminalPanel's create effect re-runs when
      // ptyEpoch changes and spawns a fresh shell at the new cwd.
      terminalRegistry.dispose(panelId)
      setPanelField(set, wsId, panelId, (panel) => ({
        ...panel,
        cwd,
        worktreeId,
        ptyEpoch: (panel.ptyEpoch ?? 0) + 1,
      }))
    },
  }
}
