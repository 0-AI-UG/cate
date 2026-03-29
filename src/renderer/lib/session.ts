// =============================================================================
// Session persistence — save/restore workspace state as JSON.
// Ported from SessionSnapshot.swift + SessionStore.swift
// =============================================================================

import { useAppStore } from '../stores/appStore'
import { useCanvasStore } from '../stores/canvasStore'
import { useDockStore } from '../stores/dockStore'
import type {
  SessionSnapshot,
  NodeSnapshot,
  MultiWorkspaceSession,
  WorkspaceState,
  DockZonePosition,
  DockZoneSnapshot,
  DockSnapshotPanel,
  PanelState,
  PanelType,
} from '../../shared/types'
import { terminalRegistry } from './terminalRegistry'

// -----------------------------------------------------------------------------
// Terminal restore data — populated during restoreSession(), consumed by
// terminalRegistry.getOrCreate() and replayTerminalLog().
// -----------------------------------------------------------------------------

export const terminalRestoreData = new Map<string, { cwd?: string; replayFromId?: string }>()

// Deferred snapshots for inactive workspaces — restored on first switch
export const deferredSnapshots = new Map<string, SessionSnapshot>()

// -----------------------------------------------------------------------------
// Dock layout serialization helper
// -----------------------------------------------------------------------------

function serializeDockLayout(
  workspace: WorkspaceState,
): Record<DockZonePosition, DockZoneSnapshot> | undefined {
  const dockState = useDockStore.getState()
  const result: Record<string, DockZoneSnapshot> = {}

  for (const position of ['left', 'right', 'bottom'] as DockZonePosition[]) {
    const zone = dockState.zones[position]
    const panels: DockSnapshotPanel[] = zone.panelIds
      .map((panelId) => {
        const panel = workspace.panels[panelId]
        if (!panel) return null
        return {
          panelId: panel.id,
          panelType: panel.type,
          title: panel.title,
          filePath: panel.filePath ?? null,
          url: panel.url ?? null,
        }
      })
      .filter(Boolean) as DockSnapshotPanel[]

    result[position] = {
      panelIds: zone.panelIds,
      activePanelIndex: zone.activePanelIndex,
      size: zone.size,
      collapsed: zone.collapsed,
      panels,
    }
  }

  return Object.values(result).some((z) => z.panelIds.length > 0)
    ? (result as Record<DockZonePosition, DockZoneSnapshot>)
    : undefined
}

// -----------------------------------------------------------------------------
// Save
// -----------------------------------------------------------------------------

export async function saveSession(): Promise<void> {
  const appState = useAppStore.getState()
  const canvasState = useCanvasStore.getState()

  // Sync current canvas state back to the selected workspace before saving
  appState.syncCanvasToWorkspace(appState.selectedWorkspaceId)

  const snapshots: SessionSnapshot[] = []

  // Skip ephemeral workspaces (no panels, no rootPath, and not deferred)
  const persistableWorkspaces = appState.workspaces.filter(
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

    // For the selected workspace, use canvasStore (most current state)
    // For others, use the workspace's stored canvasNodes
    const isSelected = workspace.id === appState.selectedWorkspaceId
    const nodes = isSelected ? canvasState.nodes : workspace.canvasNodes
    const regions = isSelected ? canvasState.regions : workspace.regions

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

    // For each terminal node in the selected workspace, fetch current working directory
    // Batch all CWD requests concurrently for better performance
    if (isSelected) {
      const cwdPromises: { snap: NodeSnapshot; promise: Promise<string | null> }[] = []
      for (const snap of nodeSnapshots) {
        if (snap.panelType === 'terminal') {
          const entry = terminalRegistry.getEntry(snap.panelId)
          if (entry?.ptyId) {
            cwdPromises.push({
              snap,
              promise: window.electronAPI.terminalGetCwd(entry.ptyId).catch(() => null),
            })
          }
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

    snapshots.push({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      rootPath: workspace.rootPath || null,
      zoomLevel: isSelected ? canvasState.zoomLevel : workspace.zoomLevel,
      viewportOffset: isSelected ? canvasState.viewportOffset : workspace.viewportOffset,
      nodes: nodeSnapshots,
      regions: Object.keys(regions).length > 0 ? { ...regions } : undefined,
      dockLayout: serializeDockLayout(workspace),
    })
  }

  const selectedIndex = persistableWorkspaces.findIndex((w) => w.id === appState.selectedWorkspaceId)

  const session: MultiWorkspaceSession = {
    version: 2,
    selectedWorkspaceIndex: selectedIndex >= 0 ? selectedIndex : null,
    workspaces: snapshots,
  }

  try {
    await window.electronAPI.sessionSave(session as any) // session save accepts any JSON
  } catch {
    // Silently ignore save failures
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
  } catch {
    return null
  }
}

// -----------------------------------------------------------------------------
// Restore
// -----------------------------------------------------------------------------

export async function restoreSession(snapshot: SessionSnapshot): Promise<void> {
  if (!snapshot?.nodes) {
    console.warn('[session] invalid snapshot (no nodes), skipping restore')
    return
  }

  const appStore = useAppStore.getState()
  const canvasStore = useCanvasStore.getState()

  const wsId = appStore.selectedWorkspaceId
  console.debug(`[session] restoring workspace ${wsId}: ${snapshot.nodes.length} nodes`)
  const t0 = performance.now()

  // Restore regions first and build old→new ID mapping
  const regionIdMap = new Map<string, string>()
  if (snapshot.regions) {
    for (const region of Object.values(snapshot.regions)) {
      const newId = canvasStore.addRegion(region.label, region.origin, region.size, region.color)
      regionIdMap.set(region.id, newId)
    }
  }

  for (let i = 0; i < snapshot.nodes.length; i++) {
    const nodeSnap = snapshot.nodes[i]
    console.debug(`[session] restoring node ${i + 1}/${snapshot.nodes.length}: ${nodeSnap.panelType} (panelId=${nodeSnap.panelId})`)
    const position = nodeSnap.origin
    const size = nodeSnap.size

    switch (nodeSnap.panelType) {
      case 'terminal': {
        const panelId = appStore.createTerminal(wsId, undefined, position)
        // Store restore metadata so the registry can pick up cwd and replay log
        terminalRestoreData.set(panelId, {
          cwd: nodeSnap.workingDirectory ?? undefined,
          replayFromId: nodeSnap.panelId,
        })
        // Update position/size for the newly created node
        const newNodeId = canvasStore.nodeForPanel(panelId)
        if (newNodeId) {
          canvasStore.moveNode(newNodeId, position)
          canvasStore.resizeNode(newNodeId, size)
          if (nodeSnap.regionId) {
            const mappedRegionId = regionIdMap.get(nodeSnap.regionId)
            if (mappedRegionId) {
              canvasStore.setNodeRegion(newNodeId, mappedRegionId)
            }
          }
        }
        break
      }
      case 'editor': {
        const panelId = appStore.createEditor(wsId, nodeSnap.filePath ?? undefined)
        const newNodeId = canvasStore.nodeForPanel(panelId)
        if (newNodeId) {
          canvasStore.moveNode(newNodeId, position)
          canvasStore.resizeNode(newNodeId, size)
          if (nodeSnap.regionId) {
            const mappedRegionId = regionIdMap.get(nodeSnap.regionId)
            if (mappedRegionId) {
              canvasStore.setNodeRegion(newNodeId, mappedRegionId)
            }
          }
        }
        break
      }
      case 'browser': {
        const panelId = appStore.createBrowser(wsId, nodeSnap.url ?? undefined)
        const newNodeId = canvasStore.nodeForPanel(panelId)
        if (newNodeId) {
          canvasStore.moveNode(newNodeId, position)
          canvasStore.resizeNode(newNodeId, size)
          if (nodeSnap.regionId) {
            const mappedRegionId = regionIdMap.get(nodeSnap.regionId)
            if (mappedRegionId) {
              canvasStore.setNodeRegion(newNodeId, mappedRegionId)
            }
          }
        }
        break
      }
    }
  }

  canvasStore.setZoom(snapshot.zoomLevel)
  canvasStore.setViewportOffset(snapshot.viewportOffset)

  // Auto-assign regionId for migrated workspaces (nodes without regionId)
  const finalState = useCanvasStore.getState()
  const allRegions = Object.values(finalState.regions)
  for (const node of Object.values(finalState.nodes)) {
    if (!node.regionId && allRegions.length > 0) {
      for (const region of allRegions) {
        const overlapX = Math.max(0, Math.min(node.origin.x + node.size.width, region.origin.x + region.size.width) - Math.max(node.origin.x, region.origin.x))
        const overlapY = Math.max(0, Math.min(node.origin.y + node.size.height, region.origin.y + region.size.height) - Math.max(node.origin.y, region.origin.y))
        const overlapArea = overlapX * overlapY
        const nodeArea = node.size.width * node.size.height
        if (nodeArea > 0 && overlapArea / nodeArea > 0.5) {
          canvasStore.setNodeRegion(node.id, region.id)
          break
        }
      }
    }
  }

  // Restore dock layout
  if (snapshot.dockLayout) {
    const dockStore = useDockStore.getState()
    dockStore.reset()

    for (const position of ['left', 'right', 'bottom'] as DockZonePosition[]) {
      const zoneSnap = snapshot.dockLayout[position]
      if (!zoneSnap || zoneSnap.panels.length === 0) continue

      for (const dockedPanel of zoneSnap.panels) {
        // Register the panel in the workspace (not as a canvas node)
        const panel: PanelState = {
          id: dockedPanel.panelId,
          type: dockedPanel.panelType as PanelType,
          title: dockedPanel.title,
          isDirty: false,
          filePath: dockedPanel.filePath ?? undefined,
          url: dockedPanel.url ?? undefined,
        }
        appStore.addPanel(wsId, panel)

        // Dock it into the appropriate zone
        useDockStore.getState().dockPanel(dockedPanel.panelId, position)
      }

      // Restore zone settings
      useDockStore.getState().resizeZone(position, zoneSnap.size)
      useDockStore.getState().setActiveTab(position, zoneSnap.activePanelIndex)
      if (zoneSnap.collapsed) {
        useDockStore.getState().setZoneCollapsed(position, true)
      }
    }
  }

  console.debug(`[session] workspace ${wsId} restored in ${(performance.now() - t0).toFixed(1)}ms`)
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

  // Write a dim "restoring" header then replay the raw log bytes
  entry.terminal.write('\x1b[90mRestoring terminal history...\x1b[0m\r\n')
  entry.terminal.write(logData)

  terminalRestoreData.delete(panelId)
}

// -----------------------------------------------------------------------------
// Restore — multi-workspace
// -----------------------------------------------------------------------------

export async function restoreMultiWorkspaceSession(session: MultiWorkspaceSession): Promise<void> {
  const appStore = useAppStore.getState()
  const tTotal = performance.now()
  console.debug(`[session] restoring multi-workspace session: ${session.workspaces.length} workspaces`)

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
    console.debug(`[session] workspace ${i + 1}/${session.workspaces.length}: "${snapshot.workspaceName}" (${snapshot.nodes.length} nodes)`)
    const wsId = appStore.addWorkspace(snapshot.workspaceName, snapshot.rootPath ?? undefined)
    wsIds.push(wsId)

    if (i === selectedIdx) {
      // Select and fully restore the active workspace
      appStore.selectWorkspace(wsId)
      await restoreSession(snapshot)
    } else {
      // Defer restoration — store the snapshot for lazy loading on first switch
      deferredSnapshots.set(wsId, snapshot)
    }
  }

  // Re-select the originally selected workspace (may be a no-op if already selected)
  if (selectedIdx < wsIds.length) {
    appStore.selectWorkspace(wsIds[selectedIdx])
  }

  console.debug(`[session] full session restored in ${(performance.now() - tTotal).toFixed(1)}ms`)
}

// -----------------------------------------------------------------------------
// Restore a deferred workspace — called on first switch to an inactive workspace
// -----------------------------------------------------------------------------

export async function restoreDeferredWorkspace(workspaceId: string): Promise<void> {
  const snapshot = deferredSnapshots.get(workspaceId)
  if (!snapshot) return
  deferredSnapshots.delete(workspaceId)
  await restoreSession(snapshot)
}

// -----------------------------------------------------------------------------
// Auto-save (debounced)
// -----------------------------------------------------------------------------

let autoSaveTimer: ReturnType<typeof setTimeout> | null = null
let autoSaveSetUp = false

export function setupAutoSave(): () => void {
  if (autoSaveSetUp) {
    return () => {}
  }
  autoSaveSetUp = true

  const unsubCanvas = useCanvasStore.subscribe(() => {
    if (autoSaveTimer) clearTimeout(autoSaveTimer)
    autoSaveTimer = setTimeout(() => saveSession(), 5000)
  })

  const unsubApp = useAppStore.subscribe(() => {
    if (autoSaveTimer) clearTimeout(autoSaveTimer)
    autoSaveTimer = setTimeout(() => saveSession(), 5000)
  })

  const unsubDock = useDockStore.subscribe(() => {
    if (autoSaveTimer) clearTimeout(autoSaveTimer)
    autoSaveTimer = setTimeout(() => saveSession(), 5000)
  })

  return () => {
    unsubCanvas()
    unsubApp()
    unsubDock()
    if (autoSaveTimer) clearTimeout(autoSaveTimer)
    autoSaveSetUp = false
  }
}
