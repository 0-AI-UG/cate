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
import { mark } from './lib/perfMarks'
// Panel chunks are loaded lazily — `restoreMultiWorkspaceSession` prefetches
// only the chunks present in the session (or a sensible default for fresh
// workspaces), so a terminal-only session doesn't download Monaco at launch.
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
import { SavedLayoutsDialog } from './dialogs/SavedLayoutsDialog'
import { loadSession, restoreSession, restoreMultiWorkspaceSession, restoreDetachedWindows, setupAutoSave, saveSession } from './lib/session'
import type { MultiWorkspaceSession } from '../shared/types'
import { useDockStore } from './stores/dockStore'
import MainWindowShell from './shells/MainWindowShell'
import PanelWindowShell from './shells/PanelWindowShell'
import DockWindowShell from './shells/DockWindowShell'
import DragGhost from './docking/DragGhost'
import { WindowTypeContext } from './stores/WindowTypeContext'
import { setupCrossWindowDragListeners } from './hooks/useDockDrag'
import { terminalRegistry } from './lib/terminalRegistry'
import { applyTheme } from './lib/themeManager'
import { useUsageStore } from './stores/usageStore'
import { confirmCloseDirtyPanels } from './lib/confirmCloseDirty'
import { confirmCloseCanvas } from './lib/confirmCloseCanvas'

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

type BootPhase = 'idle' | 'settings' | 'restoring' | 'ready'

function MainApp() {
  const [showSettings, setShowSettings] = useState(false)
  const [bootPhase, setBootPhase] = useState<BootPhase>('idle')
  const initializedRef = useRef(false)


  // Store state
  const currentWorkspace = useSelectedWorkspace()
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId)
  const showNodeSwitcher = useUIStore((s) => s.showNodeSwitcher)
  const showCommandPalette = useUIStore((s) => s.showCommandPalette)
  const showPanelSwitcher = useUIStore((s) => s.showPanelSwitcher)
  const showGlobalSearch = useUIStore((s) => s.showGlobalSearch)

  // Theme — apply on mount and re-apply whenever appearanceMode changes
  const appearanceMode = useSettingsStore((s) => s.appearanceMode)
  useEffect(() => {
    applyTheme(appearanceMode)
  }, [appearanceMode])

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
      setBootPhase('settings')

      // Wire canvas operations bridge before any workspace/panel creation
      setCanvasOperations(createCanvasOps(useCanvasStore))

      await useSettingsStore.getState().loadSettings()
      log.info('Settings loaded')
      setBootPhase('restoring')

      // Try to restore previous session — only the core (active workspace).
      // Detached panel/dock windows are recreated afterwards so the main
      // window can paint without waiting on their IPC round-trips.
      let restoredSession: MultiWorkspaceSession | null = null
      let restored = false
      const session = await loadSession()
      if (session) {
        if ((session as MultiWorkspaceSession).version === 2) {
          restoredSession = session as MultiWorkspaceSession
          await restoreMultiWorkspaceSession(restoredSession, useCanvasStore)
          restored = true
        } else {
          await restoreSession(session as any, useCanvasStore)
          restored = true
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

      // Paint the UI now — everything below this point is non-critical and
      // runs in the background so the first colorful frame lands ASAP.
      // Mark `ready` only after the center-zone canvas exists, so we don't
      // need a second paint pass to show the canvas.
      setBootPhase('ready')
      mark('first-interactive')

      // Defer detached window restore + auto-save + usage tracking until
      // after the first paint so the user sees the app immediately.
      const defer = (fn: () => void) => {
        const ric = (window as unknown as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback
        if (ric) ric(fn)
        else setTimeout(fn, 0)
      }
      defer(() => {
        if (restoredSession) {
          restoreDetachedWindows(restoredSession).catch((err) => log.warn('[session] detached restore failed:', err))
        }
        setupAutoSave(useCanvasStore)
        setupWorkspaceSync()
        // Subscribe to usage updates immediately (cheap), but delay the
        // actual scan trigger so it doesn't compete with first-frame work.
        useUsageStore.getState().init()
        setTimeout(() => {
          useUsageStore.getState().ensureLoaded()
        }, 3000)
        log.info('Background init complete')
      })
    }
    init().catch(() => setBootPhase('ready'))
  }, [])

  // first-paint marker — fires once after the first React commit. Useful to
  // measure preload-start → first-paint and renderer-script-start → first-paint.
  useEffect(() => {
    mark('first-paint')
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
  // OS-forwarded folder opens — dock drop / "Open With Cate"
  // ---------------------------------------------------------------------------
  useEffect(() => {
    return window.electronAPI.onOpenPath(async (filePath) => {
      try {
        const stat = await window.electronAPI.fsStat(filePath)
        if (!stat.isDirectory) return
        const app = useAppStore.getState()
        const folderName = filePath.split('/').filter(Boolean).pop() ?? 'Workspace'
        // If the only workspace is the untouched default (no root, empty
        // panels), reuse it rather than stacking a second empty workspace.
        const existing = app.workspaces.find((w) => w.rootPath === filePath)
        if (existing) {
          app.selectWorkspace(existing.id)
          return
        }
        const wsId = app.addWorkspace(folderName, filePath)
        window.electronAPI.recentProjectsAdd(filePath)
        await app.selectWorkspace(wsId)
      } catch (err) {
        log.warn('onOpenPath failed:', err)
      }
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
      const filePath = window.electronAPI.getPathForFile(file)
      if (!filePath) continue
      useAppStore.getState().setWorkspaceRootPath(selectedWorkspaceId, filePath)
      break
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
      const panel = ws?.panels[panelId]
      // Canvas panels get their own confirmation flow (move/delete/cancel),
      // because they may contain many child panels the user cares about.
      if (panel?.type === 'canvas') {
        const proceed = await confirmCloseCanvas(selectedWorkspaceId, panelId)
        if (!proceed) return
        useAppStore.getState().closePanel(selectedWorkspaceId, panelId)
        return
      }
      const ok = await confirmCloseDirtyPanels([panel])
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
        <Suspense fallback={<div className="w-full h-full bg-surface-4 flex items-center justify-center text-muted text-sm">Loading...</div>}>
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
          <Suspense fallback={<div className="w-full h-full bg-surface-4 flex items-center justify-center text-muted text-sm">Loading...</div>}>
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

  // Pre-ready backdrop — solid theme-colored fill (plus a faint skeleton in
  // the restoring phase) so the user sees a settled frame from the first paint
  // rather than two-phase white-flash → app.
  if (bootPhase === 'idle' || bootPhase === 'settings') {
    return (
      <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-surface-4 select-none pointer-events-none" />
    )
  }
  if (bootPhase === 'restoring') {
    return (
      <div className="fixed inset-0 z-[9999] flex bg-canvas-bg select-none pointer-events-none">
        {/* Sidebar skeleton */}
        <div className="w-[56px] h-full bg-surface-4" />
        {/* Center canvas skeleton */}
        <div className="flex-1 h-full bg-canvas-bg" />
      </div>
    )
  }

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
      <SavedLayoutsDialog />

      <ToastContainer />
      <DragGhost />
    </div>
    </CanvasStoreProvider>
  )
}
