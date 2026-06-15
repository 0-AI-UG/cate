// =============================================================================
// App — Main application component wiring all systems together.
// Ported from MainWindowView.swift
// =============================================================================

import React, { useEffect, useRef, useState, useCallback } from 'react'
import log from './lib/logger'
import { useAppStore, useSelectedWorkspace, setupWorkspaceSync, getWorkspaceCanvasStore } from './stores/appStore'
import { useCanvasStore } from './stores/canvasStore'
import { CanvasStoreProvider } from './stores/CanvasStoreContext'
import { DockStoreProvider } from './stores/DockStoreContext'
import { getOrCreateWorkspaceDockStore } from './lib/workspace/dockRegistry'
import { useStore } from 'zustand'
import { useSettingsStore } from './stores/settingsStore'
import { useUIStateStore } from './stores/uiStateStore'
import { workspaceDisplayName } from './lib/fs/displayPath'
import { useFileDropTracker, FileDropOverlay } from './drag/fileDropTarget'
import { useProcessMonitor } from './hooks/useProcessMonitor'
import { Sidebar, RightSidebar } from './sidebar/Sidebar'
import { renderPanelComponent, PANEL_REGISTRY } from './panels/registry'
import { PanelSuspense } from './panels/PanelSuspense'
const CanvasPanel = PANEL_REGISTRY.canvas.Component
import { CompanionLockOverlay } from './ui/CompanionLockOverlay'
import WindowChrome from './shells/WindowChrome'
import { PostUpdateFeedbackDialog } from './dialogs/PostUpdateFeedbackDialog'
import { UpdateReadyDialog } from './dialogs/UpdateReadyDialog'
import { WelcomeDialog } from './dialogs/WelcomeDialog'
import { OnboardingTour } from './onboarding/OnboardingTour'
import PerfHud from './ui/PerfHud'
import { initPerfClient } from './lib/perf/perfClient'
import { loadSession, restoreSession, restoreMultiWorkspaceSession, restoreDetachedWindows, setupAutoSave, saveSession } from './lib/workspace/session'
import type { MultiWorkspaceSession } from '../shared/types'
import { useDockStore } from './stores/dockStore'
import MainWindowShell from './shells/MainWindowShell'
import DockWindowShell from './shells/DockWindowShell'
import TitlebarStrip from './shells/TitlebarStrip'
import { WindowTypeContext } from './stores/WindowTypeContext'
import { setupCrossWindowDragListeners } from './drag'
import { createRemoteDropHandler } from './drag/crossWindow'
import { hydrateReceivedPanel } from './lib/panelTransfer'
import { useWindowRuntime } from './lib/hooks/useWindowRuntime'
import { closePanelWithConfirm } from './lib/closePanelWithConfirm'
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

// Themed background passed by main from the boot snapshot (the same color as the
// native window backdrop). Lets the loading splash paint in the theme color on
// the very first frame, before the renderer's JS theme injection runs.
const BOOT_BG = new URLSearchParams(window.location.search).get('bg') ?? undefined

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
  const [initializing, setInitializing] = useState(true)
  const initializedRef = useRef(false)
  // Guards against stacking reload-confirm dialogs when the detector re-fires.
  const reloadPromptOpenRef = useRef(false)

  // Track the active file-drag drop target (canvas / dock / agent) for the
  // single shared drop indicator (<FileDropOverlay/> below).
  useFileDropTracker()


  // Store state
  const currentWorkspace = useSelectedWorkspace()
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId)
  // Reload epoch for the active workspace — part of the shell key so a from-disk
  // rebuild remounts the shell (and respawns terminals) cleanly.
  const reloadEpoch = useAppStore((s) => (selectedWorkspaceId ? s.reloadEpochs[selectedWorkspaceId] ?? 0 : 0))
  // The active workspace's OWN dock + canvas stores. The shell is keyed by
  // selectedWorkspaceId so it remounts on switch and reads these — no shared
  // store is ever swapped, so content can't bleed across workspaces. These
  // re-resolve whenever MainApp re-renders (selection or `currentWorkspace`
  // panel changes), so a freshly-created center canvas is picked up.
  const activeDockStore = selectedWorkspaceId
    ? getOrCreateWorkspaceDockStore(selectedWorkspaceId)
    : useDockStore
  const activeCanvasStore = getWorkspaceCanvasStore(selectedWorkspaceId) ?? useCanvasStore

  // Shared window runtime — theme/scale, settings load, keyboard shortcuts,
  // agent-screen detector, Cmd+, settings toggle, and the external-file-drop
  // guard. Every window type mounts this; main-only behavior stays below.
  useWindowRuntime()

  // E2E test harness — exposes window.__cateE2E only when launched by Playwright.
  useEffect(() => {
    if (window.electronAPI?.isE2E) {
      import('./lib/e2eHarness').then((m) => m.installE2EHarness())
    }
  }, [])

  // Resource profiler — wires up FPS/long-task observers only under CATE_PERF=1.
  useEffect(() => {
    initPerfClient()
  }, [])

  // Main-only: terminal/agent activity → status bar + worktree sync.
  useProcessMonitor(selectedWorkspaceId)

  // Sync the OS window title to the active workspace name. On macOS this is
  // what each native tab in the title bar displays, so the user can tell
  // workspaces apart at a glance.
  useEffect(() => {
    const name = currentWorkspace?.name?.trim()
    // Treat the default "Workspace" placeholder as no real name, so the title
    // is just "Cate" until the user actually renames the workspace.
    const title = name && name !== 'Workspace' ? `${name} · Cate` : 'Cate'
    window.electronAPI?.windowSetTitle(title).catch(() => { /* noop */ })
  }, [currentWorkspace?.name])

  // When the active workspace's workspace.json is detected to have changed on
  // disk (edited externally while Cate was running), prompt to reload the
  // canvas. The detector (main's autosave guard) fires once per change via
  // WORKSPACE_EXTERNAL_EDIT.
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
          const { reloadActiveWorkspaceFromDisk } = await import('./lib/workspace/session')
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

      await useSettingsStore.getState().loadSettings()
      await useUIStateStore.getState().loadUIState()
      log.info('Settings loaded')

      // The sidebar layout lives solely in settingsStore now; components read it
      // via useSidebarLayout, so there's no uiStore copy to re-seed here.

      // Try to restore previous session — only the core (active workspace).
      // Detached panel/dock windows are recreated afterwards so the main
      // window can paint without waiting on their IPC round-trips.
      let restoredSession: MultiWorkspaceSession | null = null
      let restored = false
      const session = await loadSession()
      if (session) {
        if ((session as MultiWorkspaceSession).version === 2) {
          restoredSession = session as MultiWorkspaceSession
          await restoreMultiWorkspaceSession(restoredSession)
          restored = true
        } else {
          await restoreSession(session as any, useAppStore.getState().selectedWorkspaceId)
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

      // Ensure the selected workspace's center dock zone has a canvas panel.
      const wsId = useAppStore.getState().selectedWorkspaceId
      if (wsId) useAppStore.getState().ensureCenterCanvas(wsId)

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
      defer(async () => {
        // Recreate detached windows BEFORE autosave starts. Otherwise the first
        // autosave can run while the restored windows haven't yet synced their
        // state back to main, list zero detached windows, and overwrite
        // session.json — dropping them on the next restart. Each restored window
        // syncs as soon as it's ready (DockWindowShell), so by the time this
        // resolves main can list them.
        if (restoredSession) {
          await restoreDetachedWindows(restoredSession).catch((err) => log.warn('[session] detached restore failed:', err))
        }
        setupAutoSave()
        setupWorkspaceSync()
        log.info('Background init complete')
      })
    }
    init().catch(() => setInitializing(false))
  }, [])

  // ---------------------------------------------------------------------------
  // Auto-recreate canvas when center dock zone empties (e.g. canvas tab dragged out)
  // ---------------------------------------------------------------------------
  const centerLayout = useStore(activeDockStore, (s) => s.zones.center.layout)

  useEffect(() => {
    if (!centerLayout && selectedWorkspaceId) {
      useAppStore.getState().createCanvas(selectedWorkspaceId)
    }
  }, [centerLayout, selectedWorkspaceId])

  // ---------------------------------------------------------------------------
  // OS-forwarded folder opens — dock drop / "Open With Cate"
  // ---------------------------------------------------------------------------
  useEffect(() => {
    return window.electronAPI.onOpenPath(async (filePath) => {
      try {
        const stat = await window.electronAPI.fsStat(filePath)
        if (!stat.isDirectory) return
        const app = useAppStore.getState()
        const folderName = workspaceDisplayName(filePath) || 'Workspace'
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
    return window.electronAPI.onPanelWindowDockBack(({ snapshot }) => {
      // The detached panel window asked to dock back. Its record was removed
      // from this workspace at detach time, so we reconstruct it from the
      // snapshot the panel window sent — mirroring the cross-window DROP
      // re-integration: deposit any PTY transfer, hydrate canvas children, add
      // the panel, then dock it into the center zone.
      if (!snapshot) return

      const wsId = useAppStore.getState().selectedWorkspaceId

      // Deposit the PTY hand-off (so the terminal reconnects to the live PTY main
      // armed home, not a fresh shell) + hydrate canvas children, before mount.
      hydrateReceivedPanel(wsId, snapshot)

      useAppStore.getState().addPanel(wsId, snapshot.panel)

      // Dock into the active workspace's center zone.
      const dockStore = wsId ? getOrCreateWorkspaceDockStore(wsId) : useDockStore
      dockStore.getState().dockPanel(snapshot.panel.id, 'center')
    })
  }, [])

  // ---------------------------------------------------------------------------
  // Cross-window drag support — accept panels dragged from dock windows
  // ---------------------------------------------------------------------------
  useEffect(() => {
    return setupCrossWindowDragListeners(
      createRemoteDropHandler({
        addPanelStep: (snapshot) => {
          const wsId = useAppStore.getState().selectedWorkspaceId
          // Deposit PTY hand-off + hydrate canvas children before the panel mounts.
          hydrateReceivedPanel(wsId, snapshot)
          useAppStore.getState().addPanel(wsId, snapshot.panel)
        },
      }),
    )
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
      // Canvas panels get their own move/delete/cancel flow; everything else
      // runs the dirty/running gates. Centralised in closePanelWithConfirm so
      // the dock tab and the sidebar row behave identically.
      await closePanelWithConfirm(selectedWorkspaceId, panelId)
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

      return <PanelSuspense>{content}</PanelSuspense>
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
          <PanelSuspense>
            <CanvasPanel
              panelId={panelId}
              workspaceId={selectedWorkspaceId}
              nodeId=""
              renderPanelContent={renderPanelContent}
            />
          </PanelSuspense>
        )
      }

      // All other panels render directly
      return renderPanelContent(panelId, '', 1)
    },
    [currentWorkspace, selectedWorkspaceId, renderPanelContent],
  )

  return (
    <CanvasStoreProvider store={activeCanvasStore}>
    <div className="h-screen w-screen flex flex-col bg-canvas-bg">
      <TitlebarStrip />
      <div className="relative flex-1 min-h-0 min-w-0">
      {/* Layout row: left sidebar | shell | right sidebar. The sidebars are real
          flex items that push the shell rather than overlaying it; their own
          outer width (collapsing to 0 when empty) drives the layout. Kept in its
          own row so the overlay/modal layer below never participates in flex. */}
      <div className="absolute inset-0 flex flex-row">
      <div data-app-sidebar="left" className="flex-shrink-0 h-full"><Sidebar /></div>

      {/* Main window shell — fills the space between the two sidebars.

          Wrapped in the active workspace's dock store and KEYED by the
          workspace id so the whole dock/canvas subtree remounts on switch and
          reads that workspace's own stores — full per-workspace isolation. */}
      <div className="relative flex-1 min-h-0 min-w-0">
      <DockStoreProvider store={activeDockStore}>
      <MainWindowShell
        key={`${selectedWorkspaceId}:${reloadEpoch}`}
        renderPanel={renderDockPanel}
        getPanelTitle={getPanelTitle}
        onClosePanel={handleDockClosePanel}
      />
      </DockStoreProvider>

      {/* Companion lock: covers the canvas area when the selected remote
          workspace's companion is down. Sits inside the shell wrapper so it
          never covers the sidebars. Renders nothing for local/healthy ws. */}
      <CompanionLockOverlay />
      </div>

      {/* Right sidebar — real flex item, pushes the shell from the right. */}
      <div data-app-sidebar="right" className="flex-shrink-0 h-full"><RightSidebar /></div>
      </div>

      {/* Single shared file-drag drop indicator (canvas / dock / agent) */}
      <FileDropOverlay />

      {/* Shared overlay chrome (command palette + settings + skills +
          saved-layouts dialogs + drag overlay) — rendered for every window. */}
      <WindowChrome />

      {/* Main-only modal overlays */}
      <WelcomeDialog />
      <OnboardingTour />
      <PostUpdateFeedbackDialog />
      <UpdateReadyDialog />
      <PerfHud />

      {initializing && (
        <div
          className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-surface-4 select-none pointer-events-none"
          style={{ backgroundColor: BOOT_BG }}
        >
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
