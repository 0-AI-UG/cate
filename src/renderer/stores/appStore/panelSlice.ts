// =============================================================================
// App Store — panel creation + management slice.
// =============================================================================

import log from '../../lib/logger'
import { disambiguateTitle } from '../../lib/panelTitle'
import type { PanelState, PanelType } from '../../../shared/types'
import { BROWSER_NEW_TAB_URL } from '../../../shared/types'
import { resolvePanelSize } from '../../../shared/panels'
import { useSettingsStore } from '../settingsStore'
import { generateId } from '../canvas/helpers'
import type { AppSet, AppGet, AppStoreActions, PanelPlacement } from './types'
import {
  addAndPlacePanel,
  setPanelField,
  nextNumberedTitle,
  createCleanDockSnapshot,
} from './helpers'
import { getOrCreateCanvasStoreForPanel, releaseCanvasStoreForPanel } from '../canvasStore'
import { teardownPanelContent } from '../../lib/panels/panelTeardown'
import { collectPanelIds } from '../../lib/canvas/collectPanelIds'
import { getOrCreateWorkspaceDockStore } from '../../lib/workspace/dockRegistry'
import {
  ensureCanvasOpsForPanel,
  getCanvasOpsById,
  getNodeDockLayout,
  resolvePanelLocation,
} from '../../lib/workspace/canvasAccess'
import { clearActivePanelIfMatches } from '../../lib/activePanel'
import { recordRecentFile } from '../../lib/fs/recentFiles'

type PanelSliceActions = Pick<
  AppStoreActions,
  | 'createTerminal'
  | 'createBrowser'
  | 'createEditor'
  | 'createDiffEditor'
  | 'createCanvas'
  | 'createAgent'
  | 'createDocument'
  | 'closePanel'
  | 'updatePanelTitle'
  | 'updatePanelTitleFromAgent'
  | 'renamePanelByUser'
  | 'updatePanelUrl'
  | 'updatePanelTabs'
  | 'updatePanelProxy'
  | 'updatePanelFilePath'
  | 'setPanelDirty'
  | 'setPanelMarkdownPreview'
  | 'setPanelUnsavedContent'
  | 'addPanel'
  | 'removePanelRecord'
  | 'clearCanvas'
  | 'closeAllPanels'
  | 'bumpReloadEpoch'
>

// Stamp a canvas-bound create with the panel type's fixed default size (from
// resolvePanelSize) so the new node opens at that size — there is no user
// setting involved. Dock/none placements ignore size, and a placement that
// already pins a size (layout restore) is left as-is.
function withDefaultSize(type: PanelType, placement: PanelPlacement | undefined): PanelPlacement {
  if (placement?.target === 'dock' || placement?.target === 'none') return placement
  if (placement?.target === 'canvas' && placement.size) return placement
  const size = resolvePanelSize(type, useSettingsStore.getState())
  return {
    target: 'canvas',
    size,
    ...(placement?.target === 'canvas'
      ? { position: placement.position, canvasPanelId: placement.canvasPanelId }
      : {}),
  }
}

export function createPanelSlice(set: AppSet, get: AppGet): PanelSliceActions {
  return {
    // --- Panel creation ---

    createTerminal(workspaceId, initialInput?, position?, placement?, cwd?) {
      const panelId = generateId()
      // Auto-number terminal titles so `cate ask "Terminal 2"` and similar
      // inter-panel calls address each one unambiguously — unique across ALL
      // windows, including terminals detached into other windows.
      const panel: PanelState = {
        id: panelId,
        type: 'terminal',
        title: nextNumberedTitle(get, workspaceId, 'terminal', 'Terminal'),
        isDirty: false,
        ...(cwd ? { cwd } : {}),
      }
      return addAndPlacePanel(set, get, workspaceId, panel, withDefaultSize('terminal', placement), position)
    },

    createBrowser(workspaceId, url?, position?, placement?, proxyUrl?) {
      const panelId = generateId()
      const panel: PanelState = {
        id: panelId,
        type: 'browser',
        title: url ?? 'Browser',
        isDirty: false,
        // No URL → open the start page (not a blank page). BrowserPanel routes
        // the sentinel / about:blank / empty to <StartPage> via isStartPageUrl.
        url: url ?? BROWSER_NEW_TAB_URL,
        ...(proxyUrl ? { proxyUrl } : {}),
      }
      return addAndPlacePanel(set, get, workspaceId, panel, withDefaultSize('browser', placement), position)
    },

    createEditor(workspaceId, filePath?, position?, placement?) {
      const panelId = generateId()
      if (filePath) recordRecentFile(workspaceId, filePath)
      const fileName = filePath ? filePath.split('/').pop() ?? 'Untitled' : 'Untitled'
      const panel: PanelState = {
        id: panelId,
        type: 'editor',
        title: fileName,
        isDirty: false,
        filePath,
      }
      return addAndPlacePanel(set, get, workspaceId, panel, withDefaultSize('editor', placement), position)
    },

    createDocument(workspaceId, filePath?, documentType?, position?, placement?) {
      const panelId = generateId()
      if (filePath) recordRecentFile(workspaceId, filePath)
      const fileName = filePath ? filePath.split('/').pop() ?? 'Document' : 'Document'
      const panel: PanelState = {
        id: panelId,
        type: 'document',
        title: fileName,
        isDirty: false,
        filePath,
        documentType,
      }
      return addAndPlacePanel(set, get, workspaceId, panel, withDefaultSize('document', placement), position)
    },

    createDiffEditor(workspaceId, filePath, diffMode, position?, placement?) {
      const panelId = generateId()
      const fileName = filePath.split('/').pop() ?? 'Untitled'
      const label = diffMode === 'staged' ? 'Staged' : 'Working'
      const panel: PanelState = {
        id: panelId,
        type: 'editor',
        title: `${fileName} (${label} Diff)`,
        isDirty: false,
        filePath,
        diffMode,
      }
      return addAndPlacePanel(set, get, workspaceId, panel, withDefaultSize('editor', placement), position)
    },

    createCanvas(workspaceId, position?, placement?) {
      const panel: PanelState = {
        id: generateId(),
        type: 'canvas',
        title: 'Canvas',
        isDirty: false,
      }
      return addAndPlacePanel(set, get, workspaceId, panel, placement, position)
    },

    createAgent(workspaceId, position?, placement?) {
      // Auto-number agent panels (same scheme as terminals) so multiple agents are
      // addressable and distinct — unique across ALL windows, not just this one.
      const panel: PanelState = {
        id: generateId(),
        type: 'agent',
        title: nextNumberedTitle(get, workspaceId, 'agent', 'Agent'),
        isDirty: false,
      }
      return addAndPlacePanel(set, get, workspaceId, panel, withDefaultSize('agent', placement), position)
    },

    // --- Panel management ---

    closePanel(workspaceId, panelId) {
      const ws = get().workspaces.find((w) => w.id === workspaceId)
      const panel = ws?.panels[panelId]

      // Tear down window-local content (PTY killed, xterm + pi disposed). The
      // close-vs-transfer decision lives in teardownPanelContent — transfer
      // paths (detach, cross-window drop) go through removePanelFromWindow.
      teardownPanelContent(panelId, panel?.type, 'close')

      // A canvas takes its children with it: kill each child's content and
      // drop its record below. Without this, closing a canvas tab leaked the
      // children's PTYs and left orphaned panel records behind.
      const childIds = new Set<string>()
      if (panel?.type === 'canvas') {
        const store = getOrCreateCanvasStoreForPanel(panelId)
        for (const node of Object.values(store.getState().nodes)) {
          collectPanelIds(getNodeDockLayout(panelId, node.id), childIds)
          if (node.panelId) childIds.add(node.panelId)
        }
        for (const id of childIds) {
          teardownPanelContent(id, ws?.panels[id]?.type, 'close')
          clearActivePanelIfMatches(id)
        }
        releaseCanvasStoreForPanel(panelId)
      }

      // Remove from dock/canvas first (less critical — log errors but continue).
      // resolvePanelLocation is the canonical probe (dock tree, then every canvas
      // of the workspace) shared with panelReveal — so close removes the panel from
      // exactly where reveal/focus would have found it, no parallel probe to drift.
      const dockStore = getOrCreateWorkspaceDockStore(workspaceId)
      try {
        const location = resolvePanelLocation(workspaceId, panelId)
        if (location?.kind === 'dock') {
          dockStore.getState().undockPanel(panelId)
        } else if (location?.kind === 'canvas') {
          getCanvasOpsById(location.canvasPanelId)?.removeNodeForPanel(panelId)
        }
      } catch (error) {
        log.error('Failed to remove panel from dock/canvas during close:', error)
      }

      // Drop the canonical active-panel pointer if it was this panel, so a closed
      // panel can't keep attracting newly-created panels or read as focused.
      clearActivePanelIfMatches(panelId)

      // Remove from workspace panels (always do this to ensure cleanup)
      set((state) => ({
        workspaces: state.workspaces.map((ws) => {
          if (ws.id !== workspaceId) return ws
          const remainingPanels = { ...ws.panels }
          delete remainingPanels[panelId]
          for (const id of childIds) delete remainingPanels[id]
          return { ...ws, panels: remainingPanels }
        }),
      }))
    },

    updatePanelTitle(workspaceId, panelId, title) {
      setPanelField(set, workspaceId, panelId, (panel) => ({ ...panel, title }))
    },

    updatePanelTitleFromAgent(workspaceId, panelId, title) {
      // Disambiguation needs every sibling panel's current title, so resolve the
      // final (numbered) title against the whole workspace rather than via
      // setPanelField's single-panel updater.
      set((state) => ({
        workspaces: state.workspaces.map((ws) => {
          if (ws.id !== workspaceId) return ws
          const panel = ws.panels[panelId]
          if (!panel || panel.titleUserOverridden) return ws
          const final = disambiguateTitle(title, panelId, ws.panels)
          if (panel.title === final) return ws
          return { ...ws, panels: { ...ws.panels, [panelId]: { ...panel, title: final } } }
        }),
      }))
    },

    renamePanelByUser(workspaceId, panelId, title) {
      setPanelField(set, workspaceId, panelId, (panel) => ({ ...panel, title, titleUserOverridden: true }))
    },

    updatePanelUrl(workspaceId, panelId, url) {
      setPanelField(set, workspaceId, panelId, (panel) => ({ ...panel, url }))
    },

    updatePanelTabs(workspaceId, panelId, tabs, activeTabId) {
      // Mirror the active tab's url into `url` so restore/transfer (which read
      // `url`) reopen on the right page even if they ignore the tabs array.
      const activeUrl = tabs.find((t) => t.id === activeTabId)?.url
      setPanelField(set, workspaceId, panelId, (panel) => ({
        ...panel,
        tabs,
        activeTabId,
        ...(activeUrl !== undefined ? { url: activeUrl } : {}),
      }))
    },

    updatePanelProxy(workspaceId, panelId, proxyUrl) {
      setPanelField(set, workspaceId, panelId, (panel) => ({ ...panel, proxyUrl: proxyUrl || undefined }))
    },

    updatePanelFilePath(workspaceId, panelId, filePath) {
      setPanelField(set, workspaceId, panelId, (panel) => ({ ...panel, filePath }))
    },

    setPanelDirty(workspaceId, panelId, dirty) {
      setPanelField(set, workspaceId, panelId, (panel) => ({ ...panel, isDirty: dirty }))
    },

    setPanelMarkdownPreview(workspaceId, panelId, preview) {
      setPanelField(set, workspaceId, panelId, (panel) => ({ ...panel, markdownPreview: preview }))
    },

    setPanelUnsavedContent(workspaceId, panelId, content) {
      setPanelField(set, workspaceId, panelId, (panel) => ({ ...panel, unsavedContent: content }))
    },

    addPanel(workspaceId, panel) {
      set((state) => ({
        workspaces: state.workspaces.map((ws) =>
          ws.id === workspaceId
            ? { ...ws, panels: { ...ws.panels, [panel.id]: panel } }
            : ws,
        ),
      }))
    },

    // Remove ONLY the panels[panelId] record from a workspace (mirror of
    // addPanel). Unlike removePanel, this does NOT touch dock/canvas stores or
    // active-panel tracking — detached shells own their own dock store and undock
    // there directly, so the full removePanel would target the wrong (workspace)
    // dock registry and log spurious failures.
    removePanelRecord(workspaceId, panelId) {
      set((state) => ({
        workspaces: state.workspaces.map((ws) => {
          if (ws.id !== workspaceId) return ws
          if (!(panelId in ws.panels)) return ws
          const { [panelId]: _removed, ...remainingPanels } = ws.panels
          return { ...ws, panels: remainingPanels }
        }),
      }))
    },

    closeAllPanels(wsId) {
      const ws = get().workspaces.find((w) => w.id === wsId)
      if (!ws) return

      // Tear down every panel's content (PTY kill, xterm disposal, listener
      // cleanup, pi sessions), and release the workspace's canvas stores since
      // their panels are about to be wiped.
      const canvasPanelIds: string[] = []
      for (const panel of Object.values(ws.panels)) {
        teardownPanelContent(panel.id, panel.type, 'close')
        if (panel.type === 'canvas') canvasPanelIds.push(panel.id)
      }

      set((state) => ({
        workspaces: state.workspaces.map((w) =>
          w.id === wsId ? { ...w, panels: {} } : w,
        ),
      }))

      for (const id of canvasPanelIds) {
        try { releaseCanvasStoreForPanel(id) } catch { /* ignore */ }
      }

      // Reset the workspace's OWN dock store so the just-cleared panel IDs don't
      // linger as orphan tabs (which render as a generic "Panel" tab), then mint a
      // fresh canvas panel for the center zone.
      getOrCreateWorkspaceDockStore(wsId).getState().restoreSnapshot(createCleanDockSnapshot())
      get().ensureCenterCanvas(wsId)
    },

    bumpReloadEpoch(wsId) {
      set((state) => ({
        reloadEpochs: { ...state.reloadEpochs, [wsId]: (state.reloadEpochs[wsId] ?? 0) + 1 },
      }))
    },

    clearCanvas(wsId, canvasPanelId) {
      const ops = ensureCanvasOpsForPanel(canvasPanelId)
      const storeApi = ops.storeApi
      const state = storeApi.getState()
      const panelIds = Object.values(state.nodes).map((n) => n.panelId)
      if (panelIds.length === 0) return

      // Empty the canvas store in one synchronous step (no per-node exit
      // animation, which would otherwise leave the old nodes mid-transition).
      storeApi.getState().loadWorkspaceCanvas({}, state.viewportOffset, state.zoomLevel)

      // Tear down each node panel's content and drop the now-orphaned records.
      const ws = get().workspaces.find((w) => w.id === wsId)
      for (const pid of panelIds) {
        teardownPanelContent(pid, ws?.panels[pid]?.type, 'close')
      }
      set((s) => ({
        workspaces: s.workspaces.map((w) => {
          if (w.id !== wsId) return w
          const panels = { ...w.panels }
          for (const pid of panelIds) delete panels[pid]
          return { ...w, panels }
        }),
      }))
    },
  }
}
