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
import { releaseCanvasStoreForPanel } from '../canvasStore'
import { teardownPanelContent } from '../../lib/panels/panelTeardown'
import { teardownPanelFamily } from '../../lib/panels/panelLifecycle'
import { collectPanelIds } from '../../../shared/collectPanelIds'
import { getOrCreateWorkspaceDockStore } from '../../lib/workspace/dockRegistry'
import {
  ensureCanvasOpsForPanel,
  getCanvasOpsById,
  getNodeDockLayout,
  resolvePanelLocation,
} from '../../lib/workspace/canvasAccess'
import { clearActivePanelIfMatches } from '../../lib/activePanel'
import { pathDisplayName } from '../../lib/fs/displayPath'
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
  | 'createExtensionPanel'
  | 'closePanel'
  | 'updatePanelTitle'
  | 'updatePanelTitleFromAgent'
  | 'renamePanelByUser'
  | 'updateBrowserActiveTabUrl'
  | 'updatePanelTabs'
  | 'updatePanelProxy'
  | 'updatePanelFilePath'
  | 'setPanelDirty'
  | 'setPanelMarkdownPreview'
  | 'setPanelUnsavedContent'
  | 'setPanelAgentSession'
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
  // Spread the placement itself (size is absent — the early return above caught
  // it) so new canvas-placement fields aren't silently dropped here.
  return { ...(placement?.target === 'canvas' ? placement : {}), target: 'canvas', size }
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
      const tabId = generateId()
      const initialUrl = url ?? BROWSER_NEW_TAB_URL
      const panel: PanelState = {
        id: panelId,
        type: 'browser',
        title: url ?? 'Browser',
        isDirty: false,
        tabs: [{ id: tabId, url: initialUrl, title: '' }],
        activeTabId: tabId,
        ...(proxyUrl ? { proxyUrl } : {}),
      }
      return addAndPlacePanel(set, get, workspaceId, panel, withDefaultSize('browser', placement), position)
    },

    createEditor(workspaceId, filePath?, position?, placement?) {
      const panelId = generateId()
      if (filePath) recordRecentFile(workspaceId, filePath)
      const fileName = (filePath && pathDisplayName(filePath)) || 'Untitled'
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
      const fileName = (filePath && pathDisplayName(filePath)) || 'Document'
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
      const fileName = pathDisplayName(filePath) || 'Untitled'
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

    createExtensionPanel(workspaceId, extensionId, extensionPanelId, position?, placement?, title?) {
      const panel: PanelState = {
        id: generateId(),
        type: 'extension',
        // Default to the manifest panel id; a title-resolver / setTitle reverse
        // call can replace it with the manifest's display label.
        title: title ?? extensionPanelId,
        isDirty: false,
        extensionId,
        extensionPanelId,
      }
      return addAndPlacePanel(set, get, workspaceId, panel, withDefaultSize('extension', placement), position)
    },

    // --- Panel management ---

    closePanel(workspaceId, panelId) {
      const ws = get().workspaces.find((w) => w.id === workspaceId)
      const panel = ws?.panels[panelId]

      const childIds = teardownPanelFamily(
        panelId,
        panel?.type,
        'close',
        (id) => ws?.panels[id]?.type,
      )
      for (const id of childIds) clearActivePanelIfMatches(id)

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

    updateBrowserActiveTabUrl(workspaceId, panelId, url) {
      setPanelField(set, workspaceId, panelId, (panel) => {
        // tabs is the sole navigation authority for browser panels — a missing
        // array here is an invariant violation. Fail loud at the cause instead
        // of writing `tabs: undefined` and crashing BrowserPanel later.
        if (!panel.tabs) {
          log.error('[panelSlice] updateBrowserActiveTabUrl: panel %s has no tabs array', panelId)
          return panel
        }
        return {
          ...panel,
          tabs: panel.tabs.map((tab) =>
            tab.id === panel.activeTabId ? { ...tab, url } : tab,
          ),
        }
      })
    },

    updatePanelTabs(workspaceId, panelId, tabs, activeTabId) {
      setPanelField(set, workspaceId, panelId, (panel) => ({
        ...panel,
        tabs,
        activeTabId,
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

    setPanelAgentSession(workspaceId, panelId, session) {
      setPanelField(set, workspaceId, panelId, (panel) => {
        // Stamps are re-sent on repeat hook events / fallback probes — skip the
        // no-op write so panel state (and its session.json persistence) isn't churned.
        const prev = panel.agentSession
        if (!session && !prev) return panel
        if (
          session && prev &&
          prev.agentId === session.agentId &&
          prev.sessionId === session.sessionId &&
          prev.cwd === session.cwd
        ) return panel
        return { ...panel, agentSession: session ?? undefined }
      })
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
      const panelIds = new Set<string>()
      for (const node of Object.values(state.nodes)) {
        collectPanelIds(getNodeDockLayout(canvasPanelId, node.id), panelIds)
      }
      if (panelIds.size === 0) return

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
