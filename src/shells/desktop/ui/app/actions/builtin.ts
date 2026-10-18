// The actions ui/app owns: the palette, settings, the sidebar, overlays,
// workspace switching, undo, opening, joining and sharing workspaces, the tour, the focused panel's
// close, rename, move into the dock and claimed keys, and creating panels of every type (from the
// definitions, through client/host's panel actions).

import { defineActions, storedShortcut, type ActionId } from '@kernel/interaction/contract'
import { documentStoreFor } from '@client/document'
import {
  canMoveIntoDock,
  closePanel,
  createPanel,
  focusedLeafPanelId,
  focusedPanelId,
  panelDefinition,
  registerActions,
  moveIntoDock,
  registerPanelActions,
  requestPanelRename,
  requestPanelShortcut,
  type ActionBinding,
} from '@client/host'
import { tryClientApp } from '../app'
import { desktopPort } from '../desktop'
import { hasOverlay } from '../overlays'
import { cycleWorkspace, pickAndOpenFolder, reconnectWorkspaces } from '../navigation'
import { setUiState } from '../state/uiState'
import { useUIStore } from '../state/uiStore'

const key = storedShortcut

export const BUILTIN_ACTIONS = defineActions({
  commandPalette: {
    title: 'Command Palette',
    key: key('k', { command: true }),
    palette: false,
    welcome: true,
    menu: { bar: 'view', group: 'palette' },
    keys: { fromGuests: true },
  },
  openSettings: { title: 'Settings…', key: key(',', { command: true }), menu: { bar: 'app', group: 'settings' } },
  checkForUpdates: { title: 'Check for Updates…', menu: { bar: 'app', group: 'about' } },
  toggleSidebar: { title: 'Toggle Sidebar', key: key('b', { command: true }), welcome: true, menu: { bar: 'view', group: 'panes' } },
  nextWorkspace: { title: 'Next Workspace', key: key('→', { command: true, option: true }), menu: { bar: 'go', group: 'workspaces', order: 1 } },
  previousWorkspace: { title: 'Previous Workspace', key: key('←', { command: true, option: true }), menu: { bar: 'go', group: 'workspaces', order: 0 } },
  undo: { title: 'Undo', key: key('z', { command: true }), menu: { bar: 'edit', group: 'history' }, keys: { yieldToText: true, windowOnly: true } },
  redo: { title: 'Redo', key: key('z', { command: true, shift: true }), menu: { bar: 'edit', group: 'history' }, keys: { yieldToText: true, windowOnly: true } },
  openWorkspace: { title: 'Open Workspace…', key: key('o', { command: true }), welcome: true, menu: { bar: 'file', group: 'open', order: 0 } },
  openFolder: { title: 'Open Local Workspace…', key: key('o', { command: true, shift: true }), menu: { bar: 'file', group: 'open', order: 1 } },
  joinWorkspace: { title: 'Join with a Code…', menu: { bar: 'file', group: 'open', order: 2 } },
  shareWorkspace: { title: 'Share Workspace…', menu: { bar: 'file', group: 'open', order: 3 } },
  showTutorial: { title: 'Show Tutorial', menu: { bar: 'help', group: 'learn' } },
  saveFile: { title: 'Save', key: key('s', { command: true }), menu: { bar: 'file', group: 'save' } },
  // No native accelerator: Cmd+R must still reach a focused browser.
  renamePanel: { title: 'Rename Focused Panel', key: key('r', { command: true }), menu: { bar: 'file', group: 'close' }, keys: { windowOnly: true } },
  closePanel: { title: 'Close Panel', key: key('w', { command: true }), menu: { bar: 'file', group: 'close' } },
  moveIntoDock: { title: 'Move Panel into Dock', menu: { bar: 'window', group: 'dock' } },
  toggleFileExplorer: { title: 'Toggle File Explorer', key: key('x', { command: true, shift: true }), menu: { bar: 'view', group: 'panes' } },
  toggleSearch: { title: 'Find in Files', key: key('f', { command: true, shift: true }), menu: { bar: 'edit', group: 'find' } },
  skills: { title: 'Skills…', key: key('s', { command: true, option: true }) },
  openRepository: { title: 'Repository / Source Control Changes', key: key('g', { command: true, shift: true }) },
  openPullRequests: { title: 'Pull Requests', key: key('g', { command: true, option: true }) },
  reconnectWorkspace: { title: 'Reconnect Workspace' },
})

const selectedDocument = () => {
  const id = useUIStore.getState().selectedWorkspaceId
  return id ? documentStoreFor(id) : null
}

/** The window's workspace; without one the person picks a folder first. */
async function ensureWorkspace(workspaceId: string | null): Promise<string | null> {
  if (workspaceId) return workspaceId
  if (!(await pickAndOpenFolder())) return null
  return useUIStore.getState().selectedWorkspaceId
}

/** A new panel of a type beside the focused one: on its canvas when it sits
 *  on one (or is one), else as a tab in its stack. */
async function newPanel(type: string, workspaceId: string | null): Promise<void> {
  const ws = await ensureWorkspace(workspaceId)
  if (!ws) return
  const near = focusedLeafPanelId(ws) ?? focusedPanelId(ws) ?? undefined
  createPanel(ws, type, near ? { near } : {})
}

/** The focused panel handles an action its definition claims. */
function focusedPanelClaim(action: ActionId): ActionBinding {
  const target = (workspaceId: string | null) => {
    const panelId = workspaceId ? focusedLeafPanelId(workspaceId) : null
    const record = workspaceId && panelId ? documentStoreFor(workspaceId)?.getSnapshot().panels[panelId] : undefined
    return workspaceId && record && panelDefinition(record.type)?.claimsShortcuts?.includes(action) ? { workspaceId, panelId: record.id } : null
  }
  return {
    run({ workspaceId }) {
      const t = target(workspaceId)
      if (t) requestPanelShortcut(t.workspaceId, t.panelId, action)
    },
    enabled: ({ workspaceId }) => !!target(workspaceId),
  }
}

function overlay(view: string, section?: string): ActionBinding {
  return {
    run: () => useUIStore.getState().openOverlay({ view, ...(section ? { section } : {}) }),
    enabled: () => hasOverlay(view),
  }
}

export function registerBuiltinActions(): () => void {
  const stops = [
    registerActions(BUILTIN_ACTIONS, {
      commandPalette: { run: () => { const ui = useUIStore.getState(); ui.setCommandPaletteOpen(!ui.commandPaletteOpen) } },
      openSettings: { run: () => useUIStore.getState().toggleSettings() },
      checkForUpdates: {
        run: () => { void desktopPort()?.checkForUpdates() },
        enabled: () => !!desktopPort(),
      },
      toggleSidebar: { run: () => useUIStore.getState().toggleSidebar() },
      nextWorkspace: { run: () => cycleWorkspace(1) },
      previousWorkspace: { run: () => cycleWorkspace(-1) },
      undo: {
        run: () => { selectedDocument()?.undo() },
        enabled: () => selectedDocument()?.getUndoState().canUndo ?? false,
      },
      redo: {
        run: () => { selectedDocument()?.redo() },
        enabled: () => selectedDocument()?.getUndoState().canRedo ?? false,
      },
      openFolder: {
        run: () => { void pickAndOpenFolder() },
        enabled: () => !!desktopPort(),
      },
      openWorkspace: { run: () => useUIStore.getState().openWorkspacePicker() },
      joinWorkspace: {
        run: () => useUIStore.getState().openJoinDialog(),
        enabled: () => !!tryClientApp()?.pair,
      },
      shareWorkspace: {
        run: ({ workspaceId }) => useUIStore.getState().openShare(workspaceId),
        enabled: ({ workspaceId }) => !!workspaceId,
      },
      showTutorial: { run: () => setUiState('onboardingCompleted', false) },
      saveFile: focusedPanelClaim('saveFile'),
      renamePanel: {
        run({ workspaceId }) {
          const panelId = workspaceId ? focusedLeafPanelId(workspaceId) : null
          if (workspaceId && panelId) requestPanelRename(workspaceId, panelId)
        },
      },
      closePanel: {
        async run({ workspaceId }) {
          const panelId = workspaceId ? focusedLeafPanelId(workspaceId) : null
          if (workspaceId && panelId) await closePanel(workspaceId, panelId)
        },
      },
      moveIntoDock: {
        run({ workspaceId }) {
          const panelId = workspaceId ? focusedLeafPanelId(workspaceId) : null
          if (workspaceId && panelId) moveIntoDock(workspaceId, panelId)
        },
        enabled({ workspaceId }) {
          const panelId = workspaceId ? focusedLeafPanelId(workspaceId) : null
          return !!workspaceId && !!panelId && canMoveIntoDock(workspaceId, panelId)
        },
      },
      toggleFileExplorer: focusedPanelClaim('toggleFileExplorer'),
      toggleSearch: focusedPanelClaim('toggleSearch'),
      skills: overlay('skills'),
      openRepository: overlay('pullRequests'),
      openPullRequests: overlay('pullRequests', 'pullRequests'),
      reconnectWorkspace: {
        // Reconnects: the document and sessions load again from the runtime.
        async run({ workspaceId }) {
          if (workspaceId) await reconnectWorkspaces([workspaceId])
        },
        enabled: ({ workspaceId }) => !!workspaceId,
      },
    }),
    registerPanelActions((type, { workspaceId }) => newPanel(type, workspaceId)),
  ]
  return () => { for (const stop of stops.splice(0)) stop() }
}
