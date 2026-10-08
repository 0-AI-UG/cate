// The actions ui/app owns: the palette, settings, the sidebar, overlays,
// workspace switching, undo, opening folders, the tour, the focused panel's
// close, rename and claimed keys, and creating panels of every type (from the
// definitions, through client/host's panel actions).

import { MAIN_WINDOW } from '@workspace/document/contract'
import { clientUi, errorMessage } from '@kernel/interaction'
import { defineActions, storedShortcut, type ActionId } from '@kernel/interaction/contract'
import { documentStoreFor } from '@client/document'
import {
  addLayout,
  closePanel,
  createPanel,
  focusedLeafPanelId,
  focusedPanelId,
  panelDefinition,
  registerActions,
  registerPanelActions,
  requestPanelRename,
  requestPanelShortcut,
  stepLayout,
  type ActionBinding,
} from '@client/host'
import { clientApp, tryClientApp } from '../app'
import { desktopPort } from '../desktop'
import { hasOverlay } from '../overlays'
import { closeWorkspace, cycleWorkspace, pickAndOpenFolder, selectWorkspace } from '../navigation'
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
  newLayout: { title: 'New Layout', key: key('t', { command: true, option: true }), menu: { bar: 'go', group: 'layouts', order: 0 } },
  nextLayout: { title: 'Next Layout', key: key(']', { command: true, shift: true }), menu: { bar: 'go', group: 'layouts', order: 1 } },
  previousLayout: { title: 'Previous Layout', key: key('[', { command: true, shift: true }), menu: { bar: 'go', group: 'layouts', order: 2 } },
  undo: { title: 'Undo', key: key('z', { command: true }), menu: { bar: 'edit', group: 'history' }, keys: { yieldToText: true, windowOnly: true } },
  redo: { title: 'Redo', key: key('z', { command: true, shift: true }), menu: { bar: 'edit', group: 'history' }, keys: { yieldToText: true, windowOnly: true } },
  openFolder: { title: 'Open Folder…', key: key('o', { command: true }), menu: { bar: 'file', group: 'open' } },
  newWorkspace: { title: 'New Workspace', menu: { bar: 'file', group: 'open' } },
  showTutorial: { title: 'Show Tutorial', menu: { bar: 'help', group: 'learn' } },
  saveFile: { title: 'Save', key: key('s', { command: true }), menu: { bar: 'file', group: 'save' } },
  // No native accelerator: Cmd+R must still reach a focused browser.
  renamePanel: { title: 'Rename Focused Panel', key: key('r', { command: true }), menu: { bar: 'file', group: 'close' }, keys: { windowOnly: true } },
  closePanel: { title: 'Close Panel', key: key('w', { command: true }), menu: { bar: 'file', group: 'close' } },
  toggleFileExplorer: { title: 'Toggle File Explorer', key: key('x', { command: true, shift: true }), menu: { bar: 'view', group: 'panes' } },
  toggleSearch: { title: 'Find in Files', key: key('f', { command: true, shift: true }), menu: { bar: 'edit', group: 'find' } },
  skills: { title: 'Skills…', key: key('s', { command: true, option: true }) },
  openRepository: { title: 'Repository / Source Control Changes', key: key('g', { command: true, shift: true }) },
  openPullRequests: { title: 'Pull Requests', key: key('g', { command: true, option: true }) },
  openUsage: { title: 'Usage', key: key('u', { command: true, option: true }) },
  reloadWorkspace: { title: 'Reload Workspace from Disk' },
  deleteRuntime: { title: 'Delete Runtime' },
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

const entryOf = (workspaceId: string | null) => workspaceId ? tryClientApp()?.workspaces.get(workspaceId) ?? null : null

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
      // The layouts of the window the shortcut came from.
      newLayout: { run: ({ workspaceId, windowId }) => { if (workspaceId) addLayout(workspaceId, windowId ?? MAIN_WINDOW) }, enabled: ({ workspaceId }) => !!workspaceId },
      nextLayout: { run: ({ workspaceId, windowId }) => { if (workspaceId) stepLayout(workspaceId, windowId ?? MAIN_WINDOW, 1) }, enabled: ({ workspaceId }) => !!workspaceId },
      previousLayout: { run: ({ workspaceId, windowId }) => { if (workspaceId) stepLayout(workspaceId, windowId ?? MAIN_WINDOW, -1) }, enabled: ({ workspaceId }) => !!workspaceId },
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
      newWorkspace: {
        // The welcome screen opens or joins a workspace.
        run: () => {
          const ui = useUIStore.getState()
          ui.closeOverlay()
          ui.setSelectedWorkspace(null)
        },
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
      toggleFileExplorer: focusedPanelClaim('toggleFileExplorer'),
      toggleSearch: focusedPanelClaim('toggleSearch'),
      skills: overlay('skills'),
      openRepository: overlay('pullRequests'),
      openPullRequests: overlay('pullRequests', 'pullRequests'),
      openUsage: overlay('usage'),
      reloadWorkspace: {
        // Reconnects: the document and sessions load again from the runtime.
        async run({ workspaceId }) {
          if (!workspaceId) return
          closeWorkspace(workspaceId)
          await selectWorkspace(workspaceId)
        },
        enabled: ({ workspaceId }) => !!workspaceId,
      },
      deleteRuntime: {
        async run({ workspaceId }) {
          const entry = entryOf(workspaceId)
          if (!entry || entry.kind === 'local') return
          const ok = await clientUi().confirm(`Forget "${entry.name}"? This device can open it again only after pairing with a new code.`)
          if (!ok) return
          await clientApp().workspaces.forget(entry.id).catch((err) => clientUi().showError(errorMessage(err, 'Could not forget the workspace.')))
        },
        enabled: ({ workspaceId }) => { const entry = entryOf(workspaceId); return !!entry && entry.kind !== 'local' },
      },
    }),
    registerPanelActions((type, { workspaceId }) => newPanel(type, workspaceId)),
  ]
  return () => { for (const stop of stops.splice(0)) stop() }
}
