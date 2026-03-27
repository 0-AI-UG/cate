// =============================================================================
// Session persistence — save/restore workspace state as JSON.
// Ported from SessionSnapshot.swift + SessionStore.swift
// =============================================================================

import { useAppStore } from '../stores/appStore'
import { useCanvasStore } from '../stores/canvasStore'
import type { SessionSnapshot, NodeSnapshot, MultiWorkspaceSession } from '../../shared/types'
import { terminalRegistry } from './terminalRegistry'

// -----------------------------------------------------------------------------
// Terminal restore data — populated during restoreSession(), consumed by
// terminalRegistry.getOrCreate() and replayTerminalLog().
// -----------------------------------------------------------------------------

export const terminalRestoreData = new Map<string, { cwd?: string; replayFromId?: string }>()

// -----------------------------------------------------------------------------
// Save
// -----------------------------------------------------------------------------

export async function saveSession(): Promise<void> {
  const appState = useAppStore.getState()
  const canvasState = useCanvasStore.getState()

  // Sync current canvas state back to the selected workspace before saving
  appState.syncCanvasToWorkspace(appState.selectedWorkspaceId)

  const snapshots: SessionSnapshot[] = []

  for (const workspace of appState.workspaces) {
    // For the selected workspace, use canvasStore (most current state)
    // For others, use the workspace's stored canvasNodes
    const isSelected = workspace.id === appState.selectedWorkspaceId
    const nodes = isSelected ? canvasState.nodes : workspace.canvasNodes

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
      }
    })

    // For each terminal node in the selected workspace, fetch current working directory
    if (isSelected) {
      for (const snap of nodeSnapshots) {
        if (snap.panelType === 'terminal') {
          const entry = terminalRegistry.getEntry(snap.panelId)
          if (entry?.ptyId) {
            try {
              const cwd = await window.electronAPI.terminalGetCwd(entry.ptyId)
              snap.workingDirectory = cwd
            } catch {
              // ignore — workingDirectory will be omitted
            }
          }
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
    })
  }

  const selectedIndex = appState.workspaces.findIndex((w) => w.id === appState.selectedWorkspaceId)

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
    if ((data as any).version === 2) {
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
  const appStore = useAppStore.getState()
  const canvasStore = useCanvasStore.getState()

  const wsId = appStore.selectedWorkspaceId

  for (const nodeSnap of snapshot.nodes) {
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
        const ws = appStore.selectedWorkspace()
        const panelIds = Object.keys(ws?.panels ?? {})
        const lastPanelId = panelIds[panelIds.length - 1]
        if (lastPanelId) {
          const newNodeId = canvasStore.nodeForPanel(lastPanelId)
          if (newNodeId) {
            canvasStore.moveNode(newNodeId, position)
            canvasStore.resizeNode(newNodeId, size)
          }
        }
        break
      }
      case 'editor':
        appStore.createEditor(wsId, nodeSnap.filePath ?? undefined)
        break
      case 'browser':
        appStore.createBrowser(wsId, nodeSnap.url ?? undefined)
        break
    }

    if (nodeSnap.panelType !== 'terminal') {
      // Find the newly created node and update its position/size
      const ws = appStore.selectedWorkspace()
      const panelIds = Object.keys(ws?.panels ?? {})
      const lastPanelId = panelIds[panelIds.length - 1]
      if (lastPanelId) {
        const newNodeId = canvasStore.nodeForPanel(lastPanelId)
        if (newNodeId) {
          canvasStore.moveNode(newNodeId, position)
          canvasStore.resizeNode(newNodeId, size)
        }
      }
    }
  }

  canvasStore.setZoom(snapshot.zoomLevel)
  canvasStore.setViewportOffset(snapshot.viewportOffset)
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

  // Reuse the default workspace for the first snapshot
  const defaultWsId = appStore.workspaces[0]?.id

  for (let i = 0; i < session.workspaces.length; i++) {
    const snapshot = session.workspaces[i]

    let wsId: string
    if (i === 0 && defaultWsId) {
      // Reuse the default workspace for the first one
      wsId = defaultWsId
      appStore.renameWorkspace(wsId, snapshot.workspaceName)
      if (snapshot.rootPath) {
        appStore.setWorkspaceRootPath(wsId, snapshot.rootPath)
      }
    } else {
      wsId = appStore.addWorkspace(snapshot.workspaceName, snapshot.rootPath ?? undefined)
    }

    // Select this workspace so the canvas store is active for it
    appStore.selectWorkspace(wsId)

    // Restore panels into this workspace
    await restoreSession(snapshot)
  }

  // Re-select the originally selected workspace
  if (
    session.selectedWorkspaceIndex != null &&
    session.selectedWorkspaceIndex < appStore.workspaces.length
  ) {
    appStore.selectWorkspace(appStore.workspaces[session.selectedWorkspaceIndex].id)
  }
}

// -----------------------------------------------------------------------------
// Auto-save (debounced)
// -----------------------------------------------------------------------------

let autoSaveTimer: ReturnType<typeof setTimeout> | null = null

export function setupAutoSave(): () => void {
  const unsubCanvas = useCanvasStore.subscribe(() => {
    if (autoSaveTimer) clearTimeout(autoSaveTimer)
    autoSaveTimer = setTimeout(() => saveSession(), 5000)
  })

  const unsubApp = useAppStore.subscribe(() => {
    if (autoSaveTimer) clearTimeout(autoSaveTimer)
    autoSaveTimer = setTimeout(() => saveSession(), 5000)
  })

  return () => {
    unsubCanvas()
    unsubApp()
    if (autoSaveTimer) clearTimeout(autoSaveTimer)
  }
}
