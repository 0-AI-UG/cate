// =============================================================================
// DockWindowShell — shell for detached dock windows.
// Each dock window has its own dock store, renders a center zone with full
// split/tab support. No sidebar, canvas, or left/right/bottom zones.
// =============================================================================

import React, { useEffect, useRef, useState, useCallback, Suspense, useMemo } from 'react'
import log from '../lib/logger'
import type { DockWindowInitPayload, PanelState, PanelTransferSnapshot } from '../../shared/types'
import { createDockStore } from '../stores/dockStore'
import { DockStoreProvider } from '../stores/DockStoreContext'
import DockZone from '../docking/DockZone'
import DragGhost from '../docking/DragGhost'
import { setupCrossWindowDragListeners } from '../hooks/useDockDrag'
import { terminalRegistry } from '../lib/terminalRegistry'

const TerminalPanel = React.lazy(() => import('../panels/TerminalPanel'))
const EditorPanel = React.lazy(() => import('../panels/EditorPanel'))
const BrowserPanel = React.lazy(() => import('../panels/BrowserPanel'))
const GitPanel = React.lazy(() => import('../panels/GitPanel'))
const FileExplorerPanel = React.lazy(() => import('../panels/FileExplorerPanel'))
const ProjectListPanel = React.lazy(() => import('../panels/ProjectListPanel'))
const CanvasPanel = React.lazy(() => import('../panels/CanvasPanel'))

interface DockWindowShellProps {
  workspaceId?: string
}

export default function DockWindowShell({ workspaceId: initialWorkspaceId }: DockWindowShellProps) {
  const [panels, setPanels] = useState<Record<string, PanelState>>({})
  const [wsId, setWsId] = useState(initialWorkspaceId ?? '')
  const [ready, setReady] = useState(false)
  const dockStore = useMemo(() => createDockStore(), [])
  const syncTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Listen for DOCK_WINDOW_INIT from main process
  useEffect(() => {
    const cleanup = window.electronAPI.onDockWindowInit((payload: DockWindowInitPayload) => {
      setPanels(payload.panels)
      setWsId(payload.workspaceId)

      // Restore dock state
      dockStore.getState().restoreSnapshot({
        zones: payload.dockState,
        locations: {},
      })

      // Rebuild panel locations from the dock state
      rebuildLocations(dockStore, payload.panels)
      setReady(true)
    })

    return cleanup
  }, [dockStore])

  // Listen for incoming panel transfers (drag from other windows)
  useEffect(() => {
    const cleanup = window.electronAPI.onPanelReceive((snapshot: PanelTransferSnapshot) => {
      // Deposit transfer data BEFORE setting state (which triggers TerminalPanel mount)
      if (snapshot.terminalPtyId) {
        terminalRegistry.setPendingTransfer(snapshot.panel.id, snapshot.terminalPtyId, snapshot.terminalScrollback)
        // ACK is deferred to terminalRegistry.reconnectTerminal() after listeners are wired
      }

      setPanels((prev) => ({
        ...prev,
        [snapshot.panel.id]: snapshot.panel,
      }))
    })

    return cleanup
  }, [])

  // Set up cross-window drag listeners
  useEffect(() => {
    return setupCrossWindowDragListeners((snapshot, target) => {
      // Deposit transfer data BEFORE updating state (which triggers TerminalPanel mount)
      if (snapshot.terminalPtyId) {
        terminalRegistry.setPendingTransfer(snapshot.panel.id, snapshot.terminalPtyId, snapshot.terminalScrollback)
      }

      // A panel was dropped into this dock window from another window
      setPanels((prev) => ({
        ...prev,
        [snapshot.panel.id]: snapshot.panel,
      }))
      dockStore.getState().dockPanel(snapshot.panel.id, target.type === 'zone' ? target.zone : 'center', target)
    })
  }, [dockStore])

  // Periodic state sync to main process for session persistence
  useEffect(() => {
    const syncNow = () => {
      const snapshot = dockStore.getState().getSnapshot()
      window.electronAPI.dockWindowSyncState({
        ...snapshot,
        panels,
      })
    }

    syncTimerRef.current = setInterval(syncNow, 5000) // every 5s

    // Final sync before window closes to avoid losing state
    const handleBeforeUnload = () => syncNow()
    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      if (syncTimerRef.current) clearInterval(syncTimerRef.current)
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [dockStore, panels])

  // Render panel content inside canvas nodes (used by CanvasPanel's renderPanelContent)
  const renderPanelContent = useCallback(
    (panelId: string, nodeId: string, zoom: number) => {
      const panel = panels[panelId]
      if (!panel) return null

      let content: React.ReactNode = null
      switch (panel.type) {
        case 'terminal':
          content = <TerminalPanel panelId={panelId} workspaceId={wsId} nodeId={nodeId} />
          break
        case 'editor':
          content = <EditorPanel panelId={panelId} workspaceId={wsId} nodeId={nodeId} filePath={panel.filePath} />
          break
        case 'browser':
          content = <BrowserPanel panelId={panelId} workspaceId={wsId} nodeId={nodeId} url={panel.url} zoomLevel={zoom} />
          break
        case 'git':
          content = <GitPanel panelId={panelId} workspaceId={wsId} nodeId={nodeId} />
          break
        case 'fileExplorer':
          content = <FileExplorerPanel panelId={panelId} workspaceId={wsId} nodeId={nodeId} />
          break
        case 'projectList':
          content = <ProjectListPanel panelId={panelId} workspaceId={wsId} nodeId={nodeId} />
          break
        default:
          return null
      }

      return (
        <Suspense fallback={<div className="w-full h-full bg-[#1e1e1e] flex items-center justify-center text-zinc-500 text-sm">Loading...</div>}>
          {content}
        </Suspense>
      )
    },
    [panels, wsId],
  )

  // Render panel content for dock zones
  const renderPanel = useCallback(
    (panelId: string) => {
      const panel = panels[panelId]
      if (!panel) return null

      // Canvas panels get their own full canvas with renderPanelContent for nodes
      if (panel.type === 'canvas') {
        return (
          <Suspense fallback={<div className="w-full h-full bg-[#1e1e1e] flex items-center justify-center text-zinc-500 text-sm">Loading...</div>}>
            <CanvasPanel
              panelId={panelId}
              workspaceId={wsId}
              nodeId=""
              renderPanelContent={renderPanelContent}
            />
          </Suspense>
        )
      }

      // All other panels render directly
      return renderPanelContent(panelId, '', 1)
    },
    [panels, wsId, renderPanelContent],
  )

  const getPanelTitle = useCallback(
    (panelId: string) => panels[panelId]?.title ?? 'Panel',
    [panels],
  )

  const handleClosePanel = useCallback(
    (panelId: string) => {
      // Undock from this window's dock store
      dockStore.getState().undockPanel(panelId)
      setPanels((prev) => {
        const { [panelId]: _removed, ...rest } = prev
        return rest
      })

      // Kill terminal PTY if applicable
      const panel = panels[panelId]
      if (panel?.type === 'terminal') {
        window.electronAPI.terminalKill(panelId).catch((err) => log.warn('[dock-window] Terminal kill failed:', err))
      }

      // Close window if no panels left
      const remaining = dockStore.getState().zones
      const hasContent = Object.values(remaining).some((z) => z.layout !== null)
      if (!hasContent) {
        window.close()
      }
    },
    [dockStore, panels],
  )

  const handlePanelRemoved = useCallback(
    (_panelId: string) => {
      const remaining = dockStore.getState().zones
      const hasContent = Object.values(remaining).some((z) => z.layout !== null)
      if (!hasContent) {
        window.close()
      }
    },
    [dockStore],
  )

  if (!ready) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-[#1E1E24] text-zinc-500">
        <div className="text-sm">Loading...</div>
      </div>
    )
  }

  return (
    <DockStoreProvider store={dockStore}>
      <div className="h-screen w-screen flex flex-col bg-[#1E1E24] overflow-hidden">
        {/* macOS titlebar drag region — space for traffic lights */}
        <div
          className="h-7 flex-shrink-0"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        />
        {/* Full content area — center zone only */}
        <div className="flex-1 min-h-0 min-w-0 relative overflow-hidden">
          <DockZone
            position="center"
            renderPanel={renderPanel}
            getPanelTitle={getPanelTitle}
            onClosePanel={handleClosePanel}
            getPanel={(id) => panels[id]}
            workspaceId={wsId}
            onPanelRemoved={handlePanelRemoved}
          />
        </div>
        <DragGhost />
      </div>
    </DockStoreProvider>
  )
}

// =============================================================================
// Helpers
// =============================================================================

/** Rebuild panel locations in the dock store from the dock state */
function rebuildLocations(
  dockStore: ReturnType<typeof createDockStore>,
  panels: Record<string, PanelState>,
): void {
  const state = dockStore.getState()
  for (const panelId of Object.keys(panels)) {
    // Find the stack that contains this panel
    for (const zone of ['center', 'left', 'right', 'bottom'] as const) {
      const layout = state.zones[zone].layout
      if (!layout) continue
      const stackId = findStackForPanel(layout, panelId)
      if (stackId) {
        state.setPanelLocation(panelId, { type: 'dock', zone, stackId })
        break
      }
    }
  }
}

function findStackForPanel(node: import('../../shared/types').DockLayoutNode, panelId: string): string | null {
  if (node.type === 'tabs') {
    return node.panelIds.includes(panelId) ? node.id : null
  }
  for (const child of node.children) {
    const found = findStackForPanel(child, panelId)
    if (found) return found
  }
  return null
}
