// =============================================================================
// App — Main application component wiring all systems together.
// Ported from MainWindowView.swift
// =============================================================================

import React, { useEffect, useRef, useState, useCallback, Suspense } from 'react'
import log from './lib/logger'
import { useAppStore, useSelectedWorkspace, setupWorkspaceSync } from './stores/appStore'
import { useCanvasStore, getOrCreateCanvasStoreForPanel } from './stores/canvasStore'
import { CanvasStoreProvider } from './stores/CanvasStoreContext'
import { setCanvasOperations } from './stores/appStore'
import { createCanvasOps } from './lib/canvasBridge'
import { useSettingsStore } from './stores/settingsStore'
import { useUIStore } from './stores/uiStore'
import { useUpdateStore, type UpdateStatus } from './stores/updateStore'
import { useShortcuts } from './hooks/useShortcuts'
import { useProcessMonitor } from './hooks/useProcessMonitor'
import {
  startAgentScreenDetector,
  stopAgentScreenDetector,
  applyRemoteAgentScreenState,
} from './lib/agentScreenDetector'
import type { AgentState } from '../shared/types'
import { Sidebar, RightSidebar } from './sidebar/Sidebar'
import { renderPanelComponent, PANEL_REGISTRY } from './panels/registry'
const CanvasPanel = PANEL_REGISTRY.canvas.Component
import { NodeSwitcher } from './ui/NodeSwitcher'
import { CommandPalette } from './ui/CommandPalette'
import { SettingsWindow } from './settings/SettingsWindow'
import { SavedLayoutsDialog } from './dialogs/SavedLayoutsDialog'
import { PostUpdateFeedbackDialog } from './dialogs/PostUpdateFeedbackDialog'
import { loadSession, restoreSession, restoreMultiWorkspaceSession, restoreDetachedWindows, setupAutoSave, saveSession } from './lib/session'
import type { MultiWorkspaceSession } from '../shared/types'
import { useDockStore } from './stores/dockStore'
import MainWindowShell from './shells/MainWindowShell'
import PanelWindowShell from './shells/PanelWindowShell'
import DockWindowShell from './shells/DockWindowShell'
import TitlebarStrip from './shells/TitlebarStrip'
import { WindowTypeContext } from './stores/WindowTypeContext'
import { setupCrossWindowDragListeners } from './drag'
import { terminalRegistry } from './lib/terminalRegistry'
import { applyCanvasChildPanels } from './lib/applyCanvasChildPanels'
import { applyTheme } from './lib/themeManager'
import { confirmCloseDirtyPanels } from './lib/confirmCloseDirty'
import { confirmCloseCanvas } from './lib/confirmCloseCanvas'
import { isExternalFileDrag } from './lib/importExternalEntries'
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
  const showSettings = useUIStore((s) => s.showSettings)
  const settingsInitialTab = useUIStore((s) => s.settingsInitialTab)
  const openSettings = useUIStore((s) => s.openSettings)
  const closeSettings = useUIStore((s) => s.closeSettings)
  const [initializing, setInitializing] = useState(true)
  const initializedRef = useRef(false)
  // Guards against stacking reload-confirm dialogs when the detector re-fires.
  const reloadPromptOpenRef = useRef(false)


  // Store state
  const currentWorkspace = useSelectedWorkspace()
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId)
  const showNodeSwitcher = useUIStore((s) => s.showNodeSwitcher)
  const showCommandPalette = useUIStore((s) => s.showCommandPalette)

  // Theme — apply on mount and re-apply whenever appearanceMode changes
  const appearanceMode = useSettingsStore((s) => s.appearanceMode)
  useEffect(() => {
    applyTheme(appearanceMode)
  }, [appearanceMode])

  // E2E test harness — exposes window.__cateE2E only when launched by Playwright.
  useEffect(() => {
    if (window.electronAPI?.isE2E) {
      import('./lib/e2eHarness').then((m) => m.installE2EHarness())
    }
  }, [])

  // Global hooks
  useShortcuts()
  useProcessMonitor(selectedWorkspaceId)

  // The agent-screen detector inspects each terminal's xterm buffer for prompt
  // markers and reports the result via IPC. The unsubscribe handler also
  // applies state broadcast from other windows, so detached panel windows keep
  // the main-window sidebar in sync.
  useEffect(() => {
    startAgentScreenDetector()
    const off = window.electronAPI?.onAgentScreenStateUpdate?.(
      (terminalId: string, state: AgentState) => {
        applyRemoteAgentScreenState(terminalId, state)
      },
    )
    return () => {
      stopAgentScreenDetector()
      off?.()
    }
  }, [])

  // Sync the OS window title to the active workspace name. On macOS this is
  // what each native tab in the title bar displays, so the user can tell
  // workspaces apart at a glance.
  useEffect(() => {
    const name = currentWorkspace?.name?.trim()
    const title = name ? `${name} — Cate` : 'Cate'
    const api = (window as unknown as { electronAPI?: { windowSetTitle?: (t: string) => Promise<void> } }).electronAPI
    api?.windowSetTitle?.(title).catch(() => { /* noop */ })
  }, [currentWorkspace?.name])

  // When the active workspace's workspace.json is detected to have changed on
  // disk (edited externally, e.g. by an agent following the .cate skill), prompt
  // to reload the canvas. The detector (main's autosave guard) fires once per
  // change via WORKSPACE_EXTERNAL_EDIT.
  useEffect(() => {
    return window.electronAPI.onWorkspaceExternalEdit?.(async ({ rootPath }) => {
      if (reloadPromptOpenRef.current) return
      const app = useAppStore.getState()
      const active = app.workspaces.find((w) => w.id === app.selectedWorkspaceId)
      // Only prompt for the workspace whose canvas is currently shown.
      if (!active?.rootPath || active.rootPath !== rootPath) return

      reloadPromptOpenRef.current = true
      try {
        const choice = await window.electronAPI.confirmReloadWorkspace?.({ name: active.name })
        if (choice === 'reload') {
          const { reloadActiveWorkspaceFromDisk } = await import('./lib/session')
          await reloadActiveWorkspaceFromDisk()
        } else {
          // Declined — resume normal saving so the current canvas overwrites the
          // external edit (the file was held steady only while the prompt was up).
          await window.electronAPI.dismissWorkspaceExternalEdit?.(rootPath)
        }
      } finally {
        reloadPromptOpenRef.current = false
      }
    })
  }, [])

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
      setInitializing(false)

      // Defer detached window restore + auto-save until after the first
      // paint so the user sees the app immediately.
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
        log.info('Background init complete')
      })
    }
    init().catch(() => setInitializing(false))
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
      if (useUIStore.getState().showSettings) closeSettings()
      else openSettings()
    })
  }, [openSettings, closeSettings])

  // ---------------------------------------------------------------------------
  // Auto-updater status — push from main, surfaced as a subtle in-app pill.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const setStatus = useUpdateStore.getState().setStatus
    window.electronAPI.updateGetStatus?.().then((s: unknown) => {
      if (s && typeof s === 'object') setStatus(s as UpdateStatus)
    }).catch(() => {})
    return window.electronAPI.onUpdateStatus((status: unknown) => {
      setStatus(status as UpdateStatus)
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
      // Canvas-on-canvas is unsupported: refuse cross-window drops of a
      // canvas panel onto a canvas target. The source window stays as-is.
      if (snapshot.panel.type === 'canvas' && target.kind !== 'dock') return

      // PTY transfer MUST be deposited before any state set that mounts TerminalPanel.
      if (snapshot.terminalPtyId) {
        terminalRegistry.setPendingTransfer(snapshot.panel.id, snapshot.terminalPtyId, snapshot.terminalScrollback)
      }

      const wsId = useAppStore.getState().selectedWorkspaceId

      // Canvas panel: hydrate the per-panel canvas store with the snapshot's
      // children + child PanelState records before the panel mounts.
      if (snapshot.panel.type === 'canvas' && snapshot.canvasState) {
        const store = getOrCreateCanvasStoreForPanel(snapshot.panel.id)
        const { nodes, regions, viewportOffset, zoomLevel, childPanels } = snapshot.canvasState
        store.getState().loadWorkspaceCanvas(nodes, viewportOffset, zoomLevel, null, regions)
        applyCanvasChildPanels(wsId, childPanels ?? {})
      }

      useAppStore.getState().addPanel(wsId, snapshot.panel)

      if (target.kind === 'dock') {
        const dockTarget = target.target
        target.dockStoreApi.getState().dockPanel(
          snapshot.panel.id,
          dockTarget.type === 'zone' ? dockTarget.zone : 'center',
          dockTarget,
        )
      } else {
        const canvasState = target.canvasStoreApi.getState()
        const newNodeId = canvasState.addNode(
          snapshot.panel.id,
          snapshot.panel.type,
          target.origin,
          target.size,
        )
        target.canvasStoreApi.getState().resizeNode(newNodeId, target.size)
        target.canvasStoreApi.getState().focusNode(newNodeId)
      }
    })
  }, [])

  // ---------------------------------------------------------------------------
  // Swallow stray EXTERNAL (OS) file drops on the app background so Chromium
  // doesn't navigate to the file:// URL. The file explorer handles its own
  // external drops (copy/move into a directory) and stops propagation, so those
  // never reach here. We deliberately do NOT re-root the workspace on drop.
  //
  // Crucially, this only engages for external file drags. Internal drags
  // (workspace reorder, file-tree moves, sidebar/panel drags) bubble up to this
  // root element too — touching their dropEffect here would override the inner
  // handler's effect and make the browser reject the drop (onDrop never fires).
  // ---------------------------------------------------------------------------
  const handleFileDragOver = useCallback((e: React.DragEvent) => {
    if (!isExternalFileDrag(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'none'
  }, [])

  const handleFileDrop = useCallback((e: React.DragEvent) => {
    if (!isExternalFileDrag(e)) return
    e.preventDefault()
  }, [])

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

      // Canvas panels should not be nested on another canvas — they only live in dock zones
      if (panel.type === 'canvas') return null

      const content = renderPanelComponent(panel, { workspaceId: selectedWorkspaceId, nodeId, zoomLevel: zoom })
      if (!content) return null

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

  return (
    <CanvasStoreProvider store={useCanvasStore}>
    <div
      className="h-screen w-screen flex flex-col bg-canvas-bg"
      onDragOver={handleFileDragOver}
      onDrop={handleFileDrop}
    >
      <TitlebarStrip />
      <div className="relative flex-1 min-h-0 min-w-0">
      {/* Main window shell fills the viewport so the canvas extends edge to
          edge under the translucent sidebars. The top-level dock tab bar
          insets itself via CSS vars (--cate-left/right-sidebar-width) so the
          Canvas tab pill stays next to the sidebar. */}
      <MainWindowShell
        renderPanel={renderDockPanel}
        getPanelTitle={getPanelTitle}
        onClosePanel={handleDockClosePanel}
      />

      {/* Sidebars: absolutely-positioned overlays on top of the shell */}
      <div className="absolute inset-y-0 left-0 z-20 flex pointer-events-none">
        <div className="pointer-events-auto h-full"><Sidebar /></div>
      </div>
      <div className="absolute inset-y-0 right-0 z-20 flex pointer-events-none">
        <div className="pointer-events-auto h-full"><RightSidebar /></div>
      </div>

      {/* Modal overlays */}
      {showNodeSwitcher && <NodeSwitcher />}
      {showCommandPalette && <CommandPalette />}
      {showSettings && (
        <SettingsWindow isOpen={showSettings} onClose={closeSettings} initialTab={settingsInitialTab ?? undefined} />
      )}
      <SavedLayoutsDialog />
      <PostUpdateFeedbackDialog />

      {initializing && (
        <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-surface-4 select-none pointer-events-none">
          <svg viewBox="0 0 389 204" fill="none" xmlns="http://www.w3.org/2000/svg" className="h-8 text-muted">
            <path d="M274 203.2L307.29 1.79999H388.29L384.51 24.84H329.97L320.5 80.16H342.22H366.34L362.74 103.2H338.62H316.5L304.06 180.16H358.6L355 203.2H314.5H274Z" fill="currentColor"/>
            <path d="M201.264 203.2L230.424 26.5H197.124L201.264 1.3H294.864L290.724 26.5H257.424L228.264 203.2H201.264Z" fill="currentColor"/>
            <path d="M89 133.2L142.1 1.79999H176.3L188 133.2H161.18L159.56 103.5H128.24L117.26 133.2H89ZM136.16 81.9H158.3L157.04 50.22C156.92 45.66 156.68 41.16 156.32 36.72C156.08 32.16 155.9 28.62 155.78 26.1C154.94 28.62 153.8 32.1 152.36 36.54C151.04 40.98 149.54 45.48 147.86 50.04L136.16 81.9Z" fill="currentColor"/>
            <path d="M38.1825 135C29.4225 135 21.9825 133.38 15.8625 130.14C9.7425 126.78 5.3625 122.16 2.7225 116.28C0.0824997 110.28 -0.6375 103.32 0.5625 95.4L9.3825 39.6C10.7025 31.56 13.6425 24.6 18.2025 18.72C22.7625 12.84 28.5825 8.27999 35.6625 5.04C42.8625 1.68 50.8425 0 59.6025 0C68.4825 0 75.9225 1.68 81.9225 5.04C87.9225 8.27999 92.3025 12.84 95.0625 18.72C97.8225 24.6 98.5425 31.56 97.2225 39.6H70.2225C71.1825 34.32 70.4025 30.3 67.8825 27.54C65.3625 24.78 61.4025 23.4 56.0025 23.4C50.6025 23.4 46.2225 24.78 42.8625 27.54C39.5025 30.3 37.3425 34.32 36.3825 39.6L27.5625 95.4C26.7225 100.56 27.5625 104.58 30.0825 107.46C32.6025 110.22 36.5625 111.6 41.9625 111.6C47.3625 111.6 51.7425 110.22 55.1025 107.46C58.4625 104.58 60.5625 100.56 61.4025 95.4H88.4025C87.2025 103.32 84.2625 110.28 79.5825 116.28C75.0225 122.16 69.2025 126.78 62.1225 130.14C55.0425 133.38 47.0625 135 38.1825 135Z" fill="currentColor"/>
          </svg>
          <div className="mt-3 text-[11px] text-muted tracking-wide">v{pkg.version}</div>
        </div>
      )}
      </div>
    </div>
    </CanvasStoreProvider>
  )
}
