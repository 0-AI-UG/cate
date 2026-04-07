// =============================================================================
// Session persistence — save/restore workspace state as JSON.
// Ported from SessionSnapshot.swift + SessionStore.swift
// =============================================================================

import log from './logger'
import { useAppStore, getCanvasOperations } from '../stores/appStore'
import type { StoreApi } from 'zustand'
import type { CanvasStore } from '../stores/canvasStore'
import type {
  SessionSnapshot,
  NodeSnapshot,
  MultiWorkspaceSession,
  PanelWindowSnapshot,
  DetachedDockWindowSnapshot,
  PanelType,
} from '../../shared/types'
import { useDockStore } from '../stores/dockStore'
import { terminalRegistry } from './terminalRegistry'

// -----------------------------------------------------------------------------
// Terminal restore data — populated during restoreSession(), consumed by
// terminalRegistry.getOrCreate() and replayTerminalLog().
// -----------------------------------------------------------------------------

export const terminalRestoreData = new Map<string, { cwd?: string; replayFromId?: string }>()

// Deferred snapshots for inactive workspaces — restored on first switch
export const deferredSnapshots = new Map<string, SessionSnapshot>()

// -----------------------------------------------------------------------------
// Save
// -----------------------------------------------------------------------------

export async function saveSession(): Promise<void> {
  const appState = useAppStore.getState()

  // Sync current canvas state back to the selected workspace before saving
  // After this call, workspace.canvasNodes/regions/zoom/viewport are up to date
  appState.syncCanvasToWorkspace(appState.selectedWorkspaceId)

  // Re-read app state after sync (syncCanvasToWorkspace updates workspace data)
  const updatedState = useAppStore.getState()

  const snapshots: SessionSnapshot[] = []

  // Skip ephemeral workspaces (no panels, no rootPath, and not deferred)
  const persistableWorkspaces = updatedState.workspaces.filter(
    (ws) => Object.keys(ws.panels).length > 0 || ws.rootPath || deferredSnapshots.has(ws.id),
  )

  for (const workspace of persistableWorkspaces) {
    // If this workspace has a deferred snapshot (never switched to), re-use
    // the original snapshot data instead of serializing the empty store state.
    const deferred = deferredSnapshots.get(workspace.id)
    if (deferred) {
      snapshots.push(deferred)
      continue
    }

    const isSelected = workspace.id === updatedState.selectedWorkspaceId
    // After syncCanvasToWorkspace, workspace data is always up to date
    const nodes = workspace.canvasNodes
    const regions = workspace.regions
    const annotations = workspace.annotations

    const nodeSnapshots: NodeSnapshot[] = Object.values(nodes).map((node) => {
      const panel = workspace.panels[node.panelId]
      return {
        panelId: node.panelId,
        panelType: panel?.type ?? 'terminal',
        title: panel?.title ?? '',
        origin: node.origin,
        size: node.size,
        filePath: panel?.filePath ?? undefined,
        url: panel?.url ?? undefined,
        regionId: node.regionId ?? undefined,
      }
    })

    // Capture ptyId and save scrollback for all terminal snapshots
    const scrollbackPromises: Promise<void>[] = []
    for (const snap of nodeSnapshots) {
      if (snap.panelType === 'terminal') {
        const entry = terminalRegistry.getEntry(snap.panelId)
        if (entry?.ptyId) {
          snap.ptyId = entry.ptyId
          // Extract xterm visual buffer as plain text (same approach as cross-window transfer)
          const buffer = entry.terminal.buffer.active
          const lastRow = buffer.baseY + buffer.cursorY
          const lines: string[] = []
          for (let i = 0; i < lastRow; i++) {
            const line = buffer.getLine(i)
            if (line) lines.push(line.translateToString(true))
          }
          while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
          const content = lines.join('\n')
          if (content) {
            scrollbackPromises.push(
              window.electronAPI.terminalScrollbackSave(entry.ptyId, content).catch(() => {}),
            )
          }
        }
      }
    }
    if (scrollbackPromises.length > 0) {
      await Promise.all(scrollbackPromises)
    }

    // For each terminal node in the selected workspace, fetch current working directory
    // Batch all CWD requests concurrently for better performance
    if (isSelected) {
      const cwdPromises: { snap: NodeSnapshot; promise: Promise<string | null> }[] = []
      for (const snap of nodeSnapshots) {
        if (snap.panelType === 'terminal' && snap.ptyId) {
          cwdPromises.push({
            snap,
            promise: window.electronAPI.terminalGetCwd(snap.ptyId).catch(() => null),
          })
        }
      }
      const results = await Promise.all(cwdPromises.map((p) => p.promise))
      for (let j = 0; j < cwdPromises.length; j++) {
        const cwd = results[j]
        if (cwd) {
          cwdPromises[j].snap.workingDirectory = cwd
        }
      }
    }

    // Capture dock state — live from the dock store for the selected workspace,
    // or from the workspace's last-saved dockState for inactive workspaces.
    const dockSnapshot = isSelected
      ? useDockStore.getState().getSnapshot()
      : workspace.dockState ?? undefined

    // Collect panels that live in dock zones (not on the canvas).
    // These are panels like canvas, git, fileExplorer, projectList that are
    // referenced by the dock layout but not saved as canvas NodeSnapshots.
    let dockPanels: Record<string, import('../../shared/types').PanelState> | undefined
    if (dockSnapshot) {
      const dockPanelIds = collectPanelIdsFromDockState(dockSnapshot.zones)
      // Exclude panels already captured as canvas nodes
      const canvasNodePanelIds = new Set(nodeSnapshots.map((n) => n.panelId))
      const dockOnlyIds = dockPanelIds.filter((id) => !canvasNodePanelIds.has(id))
      if (dockOnlyIds.length > 0) {
        dockPanels = {}
        for (const id of dockOnlyIds) {
          const panel = workspace.panels[id]
          if (panel) dockPanels[id] = panel
        }
      }
    }

    snapshots.push({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      rootPath: workspace.rootPath || null,
      zoomLevel: workspace.zoomLevel,
      viewportOffset: workspace.viewportOffset,
      nodes: nodeSnapshots,
      regions: Object.keys(regions).length > 0 ? { ...regions } : undefined,
      annotations: annotations && Object.keys(annotations).length > 0 ? { ...annotations } : undefined,
      dockState: dockSnapshot,
      dockPanels,
    })
  }

  const selectedIndex = persistableWorkspaces.findIndex((w) => w.id === appState.selectedWorkspaceId)

  // Capture panel window snapshots from main process
  let panelWindows: PanelWindowSnapshot[] | undefined
  try {
    const pwList = await window.electronAPI.panelWindowsList()
    if (pwList && pwList.length > 0) {
      panelWindows = pwList.map((pw) => ({
        panel: pw.panel,
        bounds: pw.bounds,
        workspaceId: pw.workspaceId,
        terminalPtyId: pw.terminalPtyId,
      }))
    }
  } catch (err) {
    log.warn('[session] Panel window listing failed:', err)
  }

  // Capture dock window snapshots from main process
  let dockWindows: DetachedDockWindowSnapshot[] | undefined
  try {
    const dwList = await window.electronAPI.dockWindowsList()
    if (dwList && dwList.length > 0) {
      dockWindows = dwList
    }
  } catch (err) {
    log.warn('[session] Dock window listing failed:', err)
  }

  const session: MultiWorkspaceSession = {
    version: 2,
    selectedWorkspaceIndex: selectedIndex >= 0 ? selectedIndex : null,
    workspaces: snapshots,
    panelWindows,
    dockWindows,
  }

  try {
    await window.electronAPI.sessionSave(session as any) // session save accepts any JSON
  } catch (err) {
    log.warn('[session] Save failed:', err)
  }
}

// -----------------------------------------------------------------------------
// Load
// -----------------------------------------------------------------------------

export async function loadSession(): Promise<MultiWorkspaceSession | SessionSnapshot | null> {
  try {
    const data = await window.electronAPI.sessionLoad()
    if (!data) return null
    // Check if it's the new multi-workspace format
    if ((data as any).version === 2 || Array.isArray((data as any).workspaces)) {
      return data as unknown as MultiWorkspaceSession
    }
    // Legacy single-workspace format
    return data as SessionSnapshot
  } catch (err) {
    log.warn('[session] Load failed:', err)
    return null
  }
}

// -----------------------------------------------------------------------------
// Restore
// -----------------------------------------------------------------------------

export async function restoreSession(snapshot: SessionSnapshot, canvasStoreApi?: StoreApi<CanvasStore>): Promise<void> {
  if (!snapshot?.nodes) {
    log.warn('[session] invalid snapshot (no nodes), skipping restore')
    return
  }

  const appStore = useAppStore.getState()

  // Get canvas store state — either from explicit parameter or via canvasOps
  const getCanvasState = () => canvasStoreApi?.getState() ?? null

  const wsId = appStore.selectedWorkspaceId
  log.debug(`[session] restoring workspace ${wsId}: ${snapshot.nodes.length} nodes`)
  const t0 = performance.now()

  // Restore regions first and build old→new ID mapping
  const regionIdMap = new Map<string, string>()
  const cs = getCanvasState()
  if (snapshot.regions && cs) {
    for (const region of Object.values(snapshot.regions)) {
      const newId = cs.addRegion(region.label, region.origin, region.size, region.color)
      regionIdMap.set(region.id, newId)
    }
  }

  for (let i = 0; i < snapshot.nodes.length; i++) {
    const nodeSnap = snapshot.nodes[i]
    log.debug(`[session] restoring node ${i + 1}/${snapshot.nodes.length}: ${nodeSnap.panelType} (panelId=${nodeSnap.panelId})`)
    const position = nodeSnap.origin
    const size = nodeSnap.size

    switch (nodeSnap.panelType) {
      case 'terminal': {
        const panelId = appStore.createTerminal(wsId, undefined, position)
        terminalRestoreData.set(panelId, {
          cwd: nodeSnap.workingDirectory ?? undefined,
          replayFromId: nodeSnap.ptyId ?? nodeSnap.panelId,
        })
        const canvasState = getCanvasState()
        if (canvasState) {
          const newNodeId = canvasState.nodeForPanel(panelId)
          if (newNodeId) {
            canvasState.moveNode(newNodeId, position)
            canvasState.resizeNode(newNodeId, size)
            if (nodeSnap.regionId) {
              const mappedRegionId = regionIdMap.get(nodeSnap.regionId)
              if (mappedRegionId) canvasState.setNodeRegion(newNodeId, mappedRegionId)
            }
          }
        }
        break
      }
      case 'editor': {
        const panelId = appStore.createEditor(wsId, nodeSnap.filePath ?? undefined)
        const canvasState = getCanvasState()
        if (canvasState) {
          const newNodeId = canvasState.nodeForPanel(panelId)
          if (newNodeId) {
            canvasState.moveNode(newNodeId, position)
            canvasState.resizeNode(newNodeId, size)
            if (nodeSnap.regionId) {
              const mappedRegionId = regionIdMap.get(nodeSnap.regionId)
              if (mappedRegionId) canvasState.setNodeRegion(newNodeId, mappedRegionId)
            }
          }
        }
        break
      }
      case 'browser': {
        const panelId = appStore.createBrowser(wsId, nodeSnap.url ?? undefined)
        const canvasState = getCanvasState()
        if (canvasState) {
          const newNodeId = canvasState.nodeForPanel(panelId)
          if (newNodeId) {
            canvasState.moveNode(newNodeId, position)
            canvasState.resizeNode(newNodeId, size)
            if (nodeSnap.regionId) {
              const mappedRegionId = regionIdMap.get(nodeSnap.regionId)
              if (mappedRegionId) canvasState.setNodeRegion(newNodeId, mappedRegionId)
            }
          }
        }
        break
      }
    }
  }

  // Restore annotations (sticky notes, text labels) by recreating them with
  // their saved content — addAnnotation doesn't auto-edit when content is
  // supplied, so restored annotations render in their final form.
  if (snapshot.annotations) {
    const cs2 = getCanvasState()
    if (cs2) {
      for (const ann of Object.values(snapshot.annotations)) {
        const id = cs2.addAnnotation(ann.type, ann.origin, ann.content || ' ')
        // Restore exact content (addAnnotation requires non-empty to skip
        // auto-edit; we passed a space, now overwrite with the real value).
        cs2.updateAnnotation(id, ann.content)
        cs2.resizeAnnotation(id, ann.size)
        if (ann.color) cs2.updateAnnotationColor(id, ann.color)
        if (ann.fontSize) cs2.setAnnotationFontSize(id, ann.fontSize)
      }
    }
  }

  const canvasState = getCanvasState()
  if (canvasState) {
    canvasState.setZoom(snapshot.zoomLevel)
    canvasState.setViewportOffset(snapshot.viewportOffset)

    // Auto-assign regionId for migrated workspaces (nodes without regionId)
    const finalState = getCanvasState()!
    const allRegions = Object.values(finalState.regions)
    for (const node of Object.values(finalState.nodes)) {
      if (!node.regionId && allRegions.length > 0) {
        for (const region of allRegions) {
          const overlapX = Math.max(0, Math.min(node.origin.x + node.size.width, region.origin.x + region.size.width) - Math.max(node.origin.x, region.origin.x))
          const overlapY = Math.max(0, Math.min(node.origin.y + node.size.height, region.origin.y + region.size.height) - Math.max(node.origin.y, region.origin.y))
          const overlapArea = overlapX * overlapY
          const nodeArea = node.size.width * node.size.height
          if (nodeArea > 0 && overlapArea / nodeArea > 0.5) {
            canvasState.setNodeRegion(node.id, region.id)
            break
          }
        }
      }
    }
  }

  // Restore dock-zone panels (canvas, git, fileExplorer, etc.) that aren't canvas nodes
  if (snapshot.dockPanels) {
    for (const panel of Object.values(snapshot.dockPanels)) {
      appStore.addPanel(wsId, panel)
    }
    log.debug(`[session] restored ${Object.keys(snapshot.dockPanels).length} dock-zone panels for workspace ${wsId}`)
  } else if (snapshot.dockState) {
    // Migration: sessions saved before dockPanels was introduced.
    // Any panel IDs in the dock state that don't exist in the workspace are
    // almost certainly canvas panels (the only dock-only panel type).
    const dockPanelIds = collectPanelIdsFromDockState(snapshot.dockState.zones)
    const ws = appStore.getWorkspace(wsId)
    for (const panelId of dockPanelIds) {
      if (!ws?.panels[panelId]) {
        appStore.addPanel(wsId, { id: panelId, type: 'canvas', title: 'Canvas', isDirty: false })
        log.debug(`[session] migration: created missing dock panel ${panelId} as canvas`)
      }
    }
  }

  // Restore dock state if present
  if (snapshot.dockState) {
    try {
      useDockStore.getState().restoreSnapshot(snapshot.dockState)
      log.debug(`[session] dock state restored for workspace ${wsId}`)
    } catch (err) {
      log.warn('[session] failed to restore dock state:', err)
    }
  }

  log.debug(`[session] workspace ${wsId} restored in ${(performance.now() - t0).toFixed(1)}ms`)
}

// -----------------------------------------------------------------------------
// Replay terminal scrollback log
//
// Called by terminalRegistry after the PTY is fully wired and the xterm
// instance is live. Reads the persisted log for the original panel ID,
// writes it to the terminal, then clears the restore entry.
// -----------------------------------------------------------------------------

export async function replayTerminalLog(panelId: string): Promise<void> {
  const data = terminalRestoreData.get(panelId)
  if (!data?.replayFromId) return

  const logData = await window.electronAPI.terminalLogRead(data.replayFromId)
  if (!logData) {
    terminalRestoreData.delete(panelId)
    return
  }

  const entry = terminalRegistry.getEntry(panelId)
  if (!entry) {
    terminalRestoreData.delete(panelId)
    return
  }

  // Write scrollback content as plain text lines
  const lines = logData.split('\n')
  for (const line of lines) {
    entry.terminal.write(line + '\r\n')
  }
  // Dim separator between restored content and new session
  entry.terminal.write('\x1b[90m--- restored session ---\x1b[0m\r\n')

  terminalRestoreData.delete(panelId)
}

// -----------------------------------------------------------------------------
// Restore — multi-workspace
// -----------------------------------------------------------------------------

export async function restoreMultiWorkspaceSession(session: MultiWorkspaceSession, canvasStoreApi?: StoreApi<CanvasStore>): Promise<void> {
  const appStore = useAppStore.getState()
  const tTotal = performance.now()
  log.debug(`[session] restoring multi-workspace session: ${session.workspaces.length} workspaces`)

  // Clear any existing workspaces so we don't duplicate on every restart
  const existingIds = appStore.workspaces.map((w) => w.id)
  for (const id of existingIds) {
    appStore.removeWorkspace(id)
  }

  const selectedIdx = session.selectedWorkspaceIndex ?? 0

  // Create all workspaces (entries only) and only restore the active one's panels
  const wsIds: string[] = []
  for (let i = 0; i < session.workspaces.length; i++) {
    const snapshot = session.workspaces[i]
    log.debug(`[session] workspace ${i + 1}/${session.workspaces.length}: "${snapshot.workspaceName}" (${snapshot.nodes.length} nodes)`)
    const wsId = appStore.addWorkspace(snapshot.workspaceName, snapshot.rootPath ?? undefined)
    wsIds.push(wsId)

    if (i === selectedIdx) {
      // Select and fully restore the active workspace
      appStore.selectWorkspace(wsId)
      await restoreSession(snapshot, canvasStoreApi)
    } else {
      // Defer restoration — store the snapshot for lazy loading on first switch
      deferredSnapshots.set(wsId, snapshot)
    }
  }

  // Re-select the originally selected workspace (may be a no-op if already selected)
  if (selectedIdx < wsIds.length) {
    appStore.selectWorkspace(wsIds[selectedIdx])
  }

  // Recreate panel windows that were open at the time of last save
  if (session.panelWindows && session.panelWindows.length > 0) {
    log.debug(`[session] restoring ${session.panelWindows.length} panel windows`)
    for (const pw of session.panelWindows) {
      try {
        const snapshot: import('../../shared/types').PanelTransferSnapshot = {
          panel: pw.panel,
          geometry: {
            origin: { x: pw.bounds.x, y: pw.bounds.y },
            size: { width: pw.bounds.width, height: pw.bounds.height },
          },
          sourceLocation: { type: 'canvas', canvasId: '', canvasNodeId: '' },
          terminalReplayPtyId: pw.panel.type === 'terminal' ? pw.terminalPtyId : undefined,
        }
        const newWindowId = await window.electronAPI.panelTransfer(snapshot)
        if (typeof newWindowId === 'number') {
          // Position the new panel window to its saved bounds
          // The main process createWindow positions it, but we passed geometry in the snapshot
          log.debug(`[session] panel window restored: ${pw.panel.title} (windowId=${newWindowId})`)
        }
      } catch (err) {
        log.warn(`[session] failed to restore panel window "${pw.panel.title}":`, err)
      }
    }
  }

  // Recreate dock windows that were open at the time of last save
  if (session.dockWindows && session.dockWindows.length > 0) {
    log.debug(`[session] restoring ${session.dockWindows.length} dock windows`)
    for (const dw of session.dockWindows) {
      try {
        // For each panel in the dock window, create a transfer snapshot and create
        // a dock window. The first panel creates the window; remaining panels get
        // transferred to it.
        const panelIds = Object.keys(dw.panels)
        if (panelIds.length === 0) continue

        const firstPanel = dw.panels[panelIds[0]]
        const replayPtyId = firstPanel.type === 'terminal' ? dw.terminalPtyIds?.[firstPanel.id] : undefined
        const snapshot: import('../../shared/types').PanelTransferSnapshot = {
          panel: firstPanel,
          geometry: {
            origin: { x: dw.bounds.x, y: dw.bounds.y },
            size: { width: dw.bounds.width, height: dw.bounds.height },
          },
          sourceLocation: { type: 'detached', windowId: -1 },
          terminalReplayPtyId: replayPtyId,
        }

        await window.electronAPI.dragDetach(snapshot, dw.workspaceId)
        log.debug(`[session] dock window restored: ${panelIds.length} panels`)
      } catch (err) {
        log.warn(`[session] failed to restore dock window:`, err)
      }
    }
  }

  log.debug(`[session] full session restored in ${(performance.now() - tTotal).toFixed(1)}ms`)
}

// -----------------------------------------------------------------------------
// Restore a deferred workspace — called on first switch to an inactive workspace
// -----------------------------------------------------------------------------

export async function restoreDeferredWorkspace(workspaceId: string, canvasStoreApi?: StoreApi<CanvasStore>): Promise<void> {
  const snapshot = deferredSnapshots.get(workspaceId)
  if (!snapshot) return
  deferredSnapshots.delete(workspaceId)
  await restoreSession(snapshot, canvasStoreApi)
}

// -----------------------------------------------------------------------------
// Auto-save (debounced)
// -----------------------------------------------------------------------------

let autoSaveTimer: ReturnType<typeof setTimeout> | null = null
let autoSaveSetUp = false

export function setupAutoSave(canvasStoreApi?: StoreApi<CanvasStore>): () => void {
  if (autoSaveSetUp) {
    return () => {}
  }
  autoSaveSetUp = true

  const unsubCanvas = canvasStoreApi
    ? canvasStoreApi.subscribe(() => {
        if (autoSaveTimer) clearTimeout(autoSaveTimer)
        autoSaveTimer = setTimeout(() => saveSession(), 5000)
      })
    : () => {}

  const unsubApp = useAppStore.subscribe(() => {
    if (autoSaveTimer) clearTimeout(autoSaveTimer)
    autoSaveTimer = setTimeout(() => saveSession(), 5000)
  })

  const unsubDock = useDockStore.subscribe(() => {
    if (autoSaveTimer) clearTimeout(autoSaveTimer)
    autoSaveTimer = setTimeout(() => saveSession(), 5000)
  })

  // Listen for flush-save requests from main process (quit, window close)
  const unsubFlush = window.electronAPI.onSessionFlushSave(() => {
    if (autoSaveTimer) clearTimeout(autoSaveTimer)
    autoSaveTimer = null
    saveSession()
  })

  return () => {
    unsubCanvas()
    unsubApp()
    unsubDock()
    unsubFlush()
    if (autoSaveTimer) clearTimeout(autoSaveTimer)
    autoSaveSetUp = false
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Collect all panel IDs referenced in a WindowDockState layout tree. */
function collectPanelIdsFromDockState(zones: import('../../shared/types').WindowDockState): string[] {
  const ids: string[] = []
  for (const zone of Object.values(zones)) {
    if (zone.layout) collectPanelIdsFromNode(zone.layout, ids)
  }
  return ids
}

function collectPanelIdsFromNode(node: import('../../shared/types').DockLayoutNode, ids: string[]): void {
  if (node.type === 'tabs') {
    ids.push(...node.panelIds)
  } else {
    for (const child of node.children) {
      collectPanelIdsFromNode(child, ids)
    }
  }
}
