// The actions client/ui itself owns: the palette, settings, the sidebar,
// overlays, workspace switching, undo, opening folders, the tour, and the
// panel actions (new panel of a type, close, rename, the shortcuts a focused
// panel claims).

import { clientUi, errorMessage } from '@kernel/ui'
import type { ShortcutAction } from '@kernel/ui/contract'
import { documentStoreFor } from '@client/document'
import {
  closePanel,
  createPanel,
  focusedLeafPanelId,
  focusedPanelId,
  panelDefinition,
  panelTypeOpening,
  requestPanelRename,
  requestPanelShortcut,
} from '@client/host'
import { clientApp, tryClientApp } from '../app'
import { desktopPort } from '../desktop'
import { hasOverlay } from '../overlays'
import { closeWorkspace, cycleWorkspace, pickAndOpenFolder, selectWorkspace } from '../navigation'
import { setUiState } from '../state/uiState'
import { useUIStore } from '../state/uiStore'
import { bindActions, type ActionBinding } from './registry'

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
function newPanel(type: () => string | undefined): ActionBinding {
  return {
    async run({ workspaceId }) {
      const panelType = type()
      if (!panelType) return
      const ws = await ensureWorkspace(workspaceId)
      if (!ws) return
      const near = focusedLeafPanelId(ws) ?? focusedPanelId(ws) ?? undefined
      createPanel(ws, panelType, near ? { near } : {})
    },
    enabled: () => !!type() && !!panelDefinition(type()!),
  }
}

/** The focused panel handles an action its definition claims. */
function focusedPanelClaim(action: ShortcutAction): ActionBinding {
  const target = () => {
    const ws = useUIStore.getState().selectedWorkspaceId
    const panelId = ws ? focusedLeafPanelId(ws) : null
    const record = ws && panelId ? documentStoreFor(ws)?.getSnapshot().panels[panelId] : undefined
    return ws && record && panelDefinition(record.type)?.claimsShortcuts?.includes(action) ? { ws, panelId: record.id } : null
  }
  return {
    run() {
      const t = target()
      if (t) requestPanelShortcut(t.ws, t.panelId, action)
    },
    enabled: () => !!target(),
  }
}

function overlay(view: string, section?: string): ActionBinding {
  return {
    run: () => useUIStore.getState().openOverlay({ view, ...(section ? { section } : {}) }),
    enabled: () => hasOverlay(view),
  }
}

const selectedEntry = () => {
  const id = useUIStore.getState().selectedWorkspaceId
  return id ? tryClientApp()?.workspaces.get(id) ?? null : null
}

export function registerBuiltinActions(): () => void {
  return bindActions({
    commandPalette: {
      run: () => { const ui = useUIStore.getState(); ui.setCommandPaletteOpen(!ui.commandPaletteOpen) },
      inPalette: false,
    },
    openSettings: { run: () => useUIStore.getState().toggleSettings() },
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
    showTutorial: { run: () => setUiState('onboardingCompleted', false) },
    newTerminal: newPanel(() => 'terminal'),
    newBrowser: newPanel(() => 'browser'),
    newEditor: newPanel(() => 'editor'),
    newFile: newPanel(() => 'editor'),
    newAgent: newPanel(() => panelTypeOpening('conversation')),
    newCanvas: newPanel(() => 'canvas'),
    closePanel: {
      async run({ workspaceId }) {
        const panelId = workspaceId ? focusedLeafPanelId(workspaceId) : null
        if (workspaceId && panelId) await closePanel(workspaceId, panelId)
      },
    },
    renamePanel: {
      run({ workspaceId }) {
        const panelId = workspaceId ? focusedLeafPanelId(workspaceId) : null
        if (workspaceId && panelId) requestPanelRename(workspaceId, panelId)
      },
    },
    saveFile: focusedPanelClaim('saveFile'),
    toggleFileExplorer: focusedPanelClaim('toggleFileExplorer'),
    toggleSearch: focusedPanelClaim('toggleSearch'),
    skills: overlay('skills'),
    openRepository: overlay('pullRequests'),
    openPullRequests: overlay('pullRequests', 'pullRequests'),
    openUsage: overlay('usage'),
    newWorkspace: {
      // The welcome screen opens or joins a workspace.
      run: () => {
        const ui = useUIStore.getState()
        ui.closeOverlay()
        ui.setSelectedWorkspace(null)
      },
    },
    reloadWorkspace: {
      // Reconnects: the document and sessions load again from the runtime.
      async run({ workspaceId }) {
        if (!workspaceId) return
        closeWorkspace(workspaceId)
        await selectWorkspace(workspaceId)
      },
      enabled: () => !!useUIStore.getState().selectedWorkspaceId,
    },
    deleteRuntime: {
      async run() {
        const entry = selectedEntry()
        if (!entry || entry.kind === 'local') return
        const ok = await clientUi().confirm(`Forget "${entry.name}"? This device can open it again only after pairing with a new code.`)
        if (!ok) return
        await clientApp().workspaces.forget(entry.id).catch((err) => clientUi().showError(errorMessage(err, 'Could not forget the workspace.')))
      },
      enabled: () => { const entry = selectedEntry(); return !!entry && entry.kind !== 'local' },
    },
    checkForUpdates: {
      run: () => { void desktopPort()?.checkForUpdates() },
      enabled: () => !!desktopPort(),
    },
  })
}
