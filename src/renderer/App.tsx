// =============================================================================
// App — Main application component wiring all systems together.
// Ported from MainWindowView.swift
// =============================================================================

import React, { useEffect, useRef, useState, useCallback, Suspense } from 'react'
import log from './lib/logger'
import { useAppStore, useSelectedWorkspace, setupWorkspaceSync } from './stores/appStore'
import { useCanvasStore } from './stores/canvasStore'
import { CanvasStoreProvider } from './stores/CanvasStoreContext'
import { setCanvasOperations } from './stores/appStore'
import { createCanvasOps } from './lib/canvasBridge'
import { useSettingsStore } from './stores/settingsStore'
import { useUIStore } from './stores/uiStore'
import { useShortcuts } from './hooks/useShortcuts'
import { useProcessMonitor } from './hooks/useProcessMonitor'
import { Sidebar, RightSidebar } from './sidebar/Sidebar'
const TerminalPanel = React.lazy(() => import('./panels/TerminalPanel'))
const EditorPanel = React.lazy(() => import('./panels/EditorPanel'))
const BrowserPanel = React.lazy(() => import('./panels/BrowserPanel'))
const GitPanel = React.lazy(() => import('./panels/GitPanel'))
const FileExplorerPanel = React.lazy(() => import('./panels/FileExplorerPanel'))
const ProjectListPanel = React.lazy(() => import('./panels/ProjectListPanel'))
const CanvasPanel = React.lazy(() => import('./panels/CanvasPanel'))
import { NodeSwitcher } from './ui/NodeSwitcher'
import { PanelSwitcher } from './ui/PanelSwitcher'
import { CommandPalette } from './ui/CommandPalette'
import { GlobalSearch } from './ui/GlobalSearch'
import { SettingsWindow } from './settings/SettingsWindow'
import { ToastContainer } from './ui/ToastContainer'
import { AISetupDialog } from './dialogs/AISetupDialog'
import { loadSession, restoreSession, restoreMultiWorkspaceSession, setupAutoSave, saveSession } from './lib/session'
import type { MultiWorkspaceSession } from '../shared/types'
import { useDockStore } from './stores/dockStore'
import MainWindowShell from './shells/MainWindowShell'
import PanelWindowShell from './shells/PanelWindowShell'
import DockWindowShell from './shells/DockWindowShell'
import DragGhost from './docking/DragGhost'
import { WindowTypeContext } from './stores/WindowTypeContext'
import { setupCrossWindowDragListeners } from './hooks/useDockDrag'
import { terminalRegistry } from './lib/terminalRegistry'

// -----------------------------------------------------------------------------
// App
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Query param parsing for window type routing
// -----------------------------------------------------------------------------

function getWindowParams(): { type: string; panelType?: string; panelId?: string; workspaceId?: string } {
  const params = new URLSearchParams(window.location.search)
  return {
    type: params.get('type') ?? 'main',
    panelType: params.get('panelType') ?? undefined,
    panelId: params.get('panelId') ?? undefined,
    workspaceId: params.get('workspaceId') ?? undefined,
  }
}

// -----------------------------------------------------------------------------
// App — routes to the correct shell based on window type
// -----------------------------------------------------------------------------

export default function App() {
  const windowParams = getWindowParams()

  // Dock windows get a full docking shell with splits/tabs
  if (windowParams.type === 'dock') {
    return (
      <WindowTypeContext.Provider value="dock">
        <DockWindowShell workspaceId={windowParams.workspaceId} />
      </WindowTypeContext.Provider>
    )
  }

  // Panel windows get a lightweight shell — no canvas, no dock zones (legacy)
  if (windowParams.type === 'panel') {
    return (
      <PanelWindowShell
        panelType={windowParams.panelType}
        panelId={windowParams.panelId}
        workspaceId={windowParams.workspaceId}
      />
    )
  }

  return (
    <WindowTypeContext.Provider value="main">
      <MainApp />
    </WindowTypeContext.Provider>
  )
}

// -----------------------------------------------------------------------------
// MainApp — the full main window application
// -----------------------------------------------------------------------------

function MainApp() {
  const [showSettings, setShowSettings] = useState(false)
  const initializedRef = useRef(false)

  // Store state
  const currentWorkspace = useSelectedWorkspace()
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId)
  const sidebarVisible = useUIStore((s) => s.sidebarVisible)
  const showNodeSwitcher = useUIStore((s) => s.showNodeSwitcher)
  const showCommandPalette = useUIStore((s) => s.showCommandPalette)
  const showPanelSwitcher = useUIStore((s) => s.showPanelSwitcher)
  const showGlobalSearch = useUIStore((s) => s.showGlobalSearch)
  const showAISetupDialog = useUIStore((s) => s.showAISetupDialog)

  // Global hooks
  useShortcuts()
  useProcessMonitor(selectedWorkspaceId)

  // ---------------------------------------------------------------------------
  // Initialization — load settings, create first terminal
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (initializedRef.current) return
    initializedRef.current = true

    const init = async () => {
      log.info('Initializing main window...')

      // Wire canvas operations bridge before any workspace/panel creation
      setCanvasOperations(createCanvasOps(useCanvasStore))

      await useSettingsStore.getState().loadSettings()
      log.info('Settings loaded')

      // Try to restore previous session
      const settings = useSettingsStore.getState()
      let restored = false
      if (settings.restoreSessionOnLaunch) {
        const session = await loadSession()
        if (session) {
          if ((session as MultiWorkspaceSession).version === 2) {
            await restoreMultiWorkspaceSession(session as MultiWorkspaceSession, useCanvasStore)
            restored = true
          } else {
            await restoreSession(session as any, useCanvasStore)
            restored = true
          }
        }
      }

      if (restored) {
        log.info('Session restored (%d workspaces)', useAppStore.getState().workspaces.length)
      }

      // Fallback: create a default workspace with a welcome terminal only if
      // no workspaces exist (fresh install or empty session).
      if (useAppStore.getState().workspaces.length === 0) {
        log.info('No session to restore, creating default workspace')
        const wsId = useAppStore.getState().addWorkspace()
        useAppStore.getState().selectWorkspace(wsId)
      }

      // Ensure the center dock zone has a canvas panel
      const centerZone = useDockStore.getState().zones.center
      if (!centerZone.layout) {
        const wsId = useAppStore.getState().selectedWorkspaceId
        useAppStore.getState().createCanvas(wsId)
      }

      // Start auto-save and cross-window workspace sync
      setupAutoSave(useCanvasStore)
      setupWorkspaceSync()
      log.info('Auto-save configured, initialization complete')
    }
    init()
  }, [])

  // ---------------------------------------------------------------------------
  // Auto-recreate canvas when center dock zone empties (e.g. canvas tab dragged out)
  // ---------------------------------------------------------------------------
  const centerLayout = useDockStore((s) => s.zones.center.layout)

  useEffect(() => {
    if (!centerLayout && selectedWorkspaceId) {
      useAppStore.getState().createCanvas(selectedWorkspaceId)
    }
  }, [centerLayout, selectedWorkspaceId])

  // ---------------------------------------------------------------------------
  // Settings window (Cmd+, via native menu)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    return window.electronAPI.onMenuOpenSettings(() => {
      setShowSettings((s) => !s)
    })
  }, [])

  // ---------------------------------------------------------------------------
  // Panel window dock-back (double-click title bar)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    return window.electronAPI.onPanelWindowDockBack((_panelWindowId: number) => {
      // The panel window is being closed and wants to dock back.
      // For now, we don't have enough context to re-dock the specific panel,
      // since the panel window closes itself. The panel was already removed
      // from the main window when it was detached. This is a UX hook for
      // future enhancement where we'd track the source location.
    })
  }, [])

  // ---------------------------------------------------------------------------
  // Cross-window drag support — accept panels dragged from dock windows
  // ---------------------------------------------------------------------------
  useEffect(() => {
    return setupCrossWindowDragListeners((snapshot, target) => {
      // Deposit transfer data BEFORE updating state (which triggers TerminalPanel mount)
      if (snapshot.terminalPtyId) {
        terminalRegistry.setPendingTransfer(snapshot.panel.id, snapshot.terminalPtyId, snapshot.terminalScrollback)
      }

      // A panel was dropped into the main window from another window
      const wsId = useAppStore.getState().selectedWorkspaceId
      useAppStore.getState().addPanel(wsId, snapshot.panel)
      useDockStore.getState().dockPanel(
        snapshot.panel.id,
        target.type === 'zone' ? target.zone : 'center',
        target,
      )
    })
  }, [])

  // ---------------------------------------------------------------------------
  // Drag-and-drop folder from Finder
  // ---------------------------------------------------------------------------
  const handleFileDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleFileDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files)
    for (const file of files) {
      const filePath = (file as any).path as string | undefined
      if (!filePath) continue
      try {
        const stat = await window.electronAPI.fsStat(filePath)
        if (stat.isDirectory) {
          useAppStore.getState().setWorkspaceRootPath(selectedWorkspaceId, filePath)
          break
        }
      } catch { /* ignore */ }
    }
  }, [selectedWorkspaceId])

  // ---------------------------------------------------------------------------
  // Dock zone panel helpers
  // ---------------------------------------------------------------------------
  const getPanelTitle = useCallback(
    (panelId: string) => {
      if (!currentWorkspace) return 'Panel'
      return currentWorkspace.panels[panelId]?.title ?? 'Panel'
    },
    [currentWorkspace],
  )

  const handleDockClosePanel = useCallback(
    (panelId: string) => {
      useAppStore.getState().closePanel(selectedWorkspaceId, panelId)
    },
    [selectedWorkspaceId],
  )

  // ---------------------------------------------------------------------------
  // Render panel content (used both in dock zones and inside canvas nodes)
  // ---------------------------------------------------------------------------
  const renderPanelContent = useCallback(
    (panelId: string, nodeId: string, zoom: number) => {
      if (!currentWorkspace) return null
      const panel = currentWorkspace.panels[panelId]
      if (!panel) return null

      let content: React.ReactNode = null
      switch (panel.type) {
        case 'terminal':
          content = <TerminalPanel panelId={panelId} workspaceId={selectedWorkspaceId} nodeId={nodeId} />
          break
        case 'editor':
          content = <EditorPanel panelId={panelId} workspaceId={selectedWorkspaceId} nodeId={nodeId} filePath={panel.filePath} />
          break
        case 'browser':
          content = <BrowserPanel panelId={panelId} workspaceId={selectedWorkspaceId} nodeId={nodeId} url={panel.url} zoomLevel={zoom} />
          break
        case 'git':
          content = <GitPanel panelId={panelId} workspaceId={selectedWorkspaceId} nodeId={nodeId} />
          break
        case 'fileExplorer':
          content = <FileExplorerPanel panelId={panelId} workspaceId={selectedWorkspaceId} nodeId={nodeId} />
          break
        case 'projectList':
          content = <ProjectListPanel panelId={panelId} workspaceId={selectedWorkspaceId} nodeId={nodeId} />
          break
        case 'canvas':
          // Canvas panels should not be nested on another canvas — they only live in dock zones
          return null
        default:
          return null
      }

      return (
        <Suspense fallback={<div className="w-full h-full bg-[#1e1e1e] flex items-center justify-center text-zinc-500 text-sm">Loading...</div>}>
          {content}
        </Suspense>
      )
    },
    [currentWorkspace, selectedWorkspaceId],
  )

  /** Render a panel for use inside a dock zone (no canvas node wrapper) */
  const renderDockPanel = useCallback(
    (panelId: string) => {
      if (!currentWorkspace) return null
      const panel = currentWorkspace.panels[panelId]
      if (!panel) return null

      // Canvas panels get their own full canvas with renderPanelContent for nodes
      if (panel.type === 'canvas') {
        return (
          <Suspense fallback={<div className="w-full h-full bg-[#1e1e1e] flex items-center justify-center text-zinc-500 text-sm">Loading...</div>}>
            <CanvasPanel
              panelId={panelId}
              workspaceId={selectedWorkspaceId}
              nodeId=""
              renderPanelContent={renderPanelContent}
            />
          </Suspense>
        )
      }

      // All other panels render directly
      return renderPanelContent(panelId, '', 1)
    },
    [currentWorkspace, selectedWorkspaceId, renderPanelContent],
  )

  return (
    <CanvasStoreProvider store={useCanvasStore}>
    <div className="h-screen w-screen flex bg-canvas-bg" onDragOver={handleFileDragOver} onDrop={handleFileDrop}>
      {/* Sidebar */}
      <Sidebar isVisible={sidebarVisible} />

      {/* Main window shell: all dock zones including center */}
      <MainWindowShell
        renderPanel={renderDockPanel}
        getPanelTitle={getPanelTitle}
        onClosePanel={handleDockClosePanel}
      />

      {/* Right Sidebar */}
      <RightSidebar />

      {/* Modal overlays */}
      {showNodeSwitcher && <NodeSwitcher />}
      {showPanelSwitcher && <PanelSwitcher />}
      {showCommandPalette && <CommandPalette />}
      {showGlobalSearch && <GlobalSearch />}
      {showSettings && (
        <SettingsWindow isOpen={showSettings} onClose={() => setShowSettings(false)} />
      )}
      {showAISetupDialog && (
        <AISetupDialog workspaceId={selectedWorkspaceId} />
      )}

      <ToastContainer />
      <DragGhost />
    </div>
    </CanvasStoreProvider>
  )
}
