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
import { useUsageStore } from './stores/usageStore'
import { confirmCloseDirtyPanels } from './lib/confirmCloseDirty'
import pkg from '../../package.json'

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
  const [initializing, setInitializing] = useState(true)
  const initializedRef = useRef(false)


  // Store state
  const currentWorkspace = useSelectedWorkspace()
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId)
  const showNodeSwitcher = useUIStore((s) => s.showNodeSwitcher)
  const showCommandPalette = useUIStore((s) => s.showCommandPalette)
  const showPanelSwitcher = useUIStore((s) => s.showPanelSwitcher)
  const showGlobalSearch = useUIStore((s) => s.showGlobalSearch)
  const showAISetupDialog = useUIStore((s) => s.showAISetupDialog)

  // Global hooks
  useShortcuts()
  useProcessMonitor(selectedWorkspaceId)

  // Sync the OS window title to the active workspace name. On macOS this is
  // what each native tab in the title bar displays, so the user can tell
  // workspaces apart at a glance.
  useEffect(() => {
    const name = currentWorkspace?.name?.trim()
    const title = name ? `${name} — Cate` : 'Cate'
    const api = (window as unknown as { electronAPI?: { windowSetTitle?: (t: string) => Promise<void> } }).electronAPI
    api?.windowSetTitle?.(title).catch(() => { /* noop */ })
  }, [currentWorkspace?.name])

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
      setInitializing(false)
    }
    init().catch(() => setInitializing(false))

    // Initialize usage store (token tracking)
    const cleanupUsage = useUsageStore.getState().init()
    return cleanupUsage
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
    if (files.length === 0) return
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
    async (panelId: string) => {
      const ws = useAppStore.getState().workspaces.find((w) => w.id === selectedWorkspaceId)
      const ok = await confirmCloseDirtyPanels([ws?.panels[panelId]])
      if (!ok) return
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
        <Suspense fallback={<div className="w-full h-full bg-[#1f1e1c] flex items-center justify-center text-zinc-500 text-sm">Loading...</div>}>
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
          <Suspense fallback={<div className="w-full h-full bg-[#1f1e1c] flex items-center justify-center text-zinc-500 text-sm">Loading...</div>}>
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
      <Sidebar />

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

      {initializing && (
        <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-[#1f1e1c] select-none pointer-events-none">
          <svg viewBox="0 0 389 204" fill="none" xmlns="http://www.w3.org/2000/svg" className="h-8 text-white/25">
            <path d="M274 203.2L307.29 1.79999H388.29L384.51 24.84H329.97L320.5 80.16H342.22H366.34L362.74 103.2H338.62H316.5L304.06 180.16H358.6L355 203.2H314.5H274Z" fill="currentColor"/>
            <path d="M201.264 203.2L230.424 26.5H197.124L201.264 1.3H294.864L290.724 26.5H257.424L228.264 203.2H201.264Z" fill="currentColor"/>
            <path d="M89 133.2L142.1 1.79999H176.3L188 133.2H161.18L159.56 103.5H128.24L117.26 133.2H89ZM136.16 81.9H158.3L157.04 50.22C156.92 45.66 156.68 41.16 156.32 36.72C156.08 32.16 155.9 28.62 155.78 26.1C154.94 28.62 153.8 32.1 152.36 36.54C151.04 40.98 149.54 45.48 147.86 50.04L136.16 81.9Z" fill="currentColor"/>
            <path d="M38.1825 135C29.4225 135 21.9825 133.38 15.8625 130.14C9.7425 126.78 5.3625 122.16 2.7225 116.28C0.0824997 110.28 -0.6375 103.32 0.5625 95.4L9.3825 39.6C10.7025 31.56 13.6425 24.6 18.2025 18.72C22.7625 12.84 28.5825 8.27999 35.6625 5.04C42.8625 1.68 50.8425 0 59.6025 0C68.4825 0 75.9225 1.68 81.9225 5.04C87.9225 8.27999 92.3025 12.84 95.0625 18.72C97.8225 24.6 98.5425 31.56 97.2225 39.6H70.2225C71.1825 34.32 70.4025 30.3 67.8825 27.54C65.3625 24.78 61.4025 23.4 56.0025 23.4C50.6025 23.4 46.2225 24.78 42.8625 27.54C39.5025 30.3 37.3425 34.32 36.3825 39.6L27.5625 95.4C26.7225 100.56 27.5625 104.58 30.0825 107.46C32.6025 110.22 36.5625 111.6 41.9625 111.6C47.3625 111.6 51.7425 110.22 55.1025 107.46C58.4625 104.58 60.5625 100.56 61.4025 95.4H88.4025C87.2025 103.32 84.2625 110.28 79.5825 116.28C75.0225 122.16 69.2025 126.78 62.1225 130.14C55.0425 133.38 47.0625 135 38.1825 135Z" fill="currentColor"/>
          </svg>
          <div className="mt-3 text-[11px] text-white/20 tracking-wide">v{pkg.version}</div>
        </div>
      )}
    </div>
    </CanvasStoreProvider>
  )
}
