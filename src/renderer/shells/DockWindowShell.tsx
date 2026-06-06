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
import { DragOverlay, setupCrossWindowDragListeners } from '../drag'
import { terminalRegistry } from '../lib/terminal/terminalRegistry'
import { terminalRestoreData } from '../lib/workspace/session'
import { getOrCreateCanvasStoreForPanel } from '../stores/canvasStore'
import { ensurePanelsInAppStore } from '../lib/canvas/applyCanvasChildPanels'
import { useAppStore } from '../stores/appStore'
import { confirmCloseDirtyPanels } from '../lib/confirmCloseDirty'
import { confirmCloseRunningTerminals } from '../lib/confirmCloseTerminal'
import { isDockEmpty } from './dockEmpty'
import { shouldCloseDockWindow } from './shouldCloseDockWindow'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStateStore } from '../stores/uiStateStore'
import { useUIStore } from '../stores/uiStore'
import { SettingsWindow } from '../settings/SettingsWindow'
import { applyTheme } from '../lib/themeManager'

import { renderPanelComponent, PANEL_REGISTRY } from '../panels/registry'
const CanvasPanel = PANEL_REGISTRY.canvas.Component

interface DockWindowShellProps {
  workspaceId?: string
}

// Stable empty map so the appStore selector returns the same reference while a
// workspace is absent — avoids re-render churn and effect re-runs from a fresh
// `{}` each render.
const EMPTY: Record<string, PanelState> = {}

export default function DockWindowShell({ workspaceId: initialWorkspaceId }: DockWindowShellProps) {
  const [wsId, setWsId] = useState(initialWorkspaceId ?? '')
  const [ready, setReady] = useState(false)
  const dockStore = useMemo(() => createDockStore(), [])
  const syncTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const hadPanelsRef = useRef(false)

  // The detached window's own appStore is the single in-window source of truth
  // for panels: transferred panels are merged into a stub workspace (see
  // ensurePanelsInAppStore), and panel components write their live url/isDirty/
  // filePath edits straight into it. We render FROM this selector rather than a
  // local React copy, so those live edits show up here AND in session capture.
  const panels = useAppStore((s) => s.workspaces.find((w) => w.id === wsId)?.panels ?? EMPTY)

  // wsId mirror so syncNow (and other callbacks) can read the current id
  // without re-closing over stale state.
  const wsIdRef = useRef(wsId)
  wsIdRef.current = wsId

  // Hydrate settings + apply theme so the detached window mirrors the main
  // app's appearance (theme, minimap, canvas grid, etc.). Without this the
  // window renders with default settings and ignores the user's preferences.
  useEffect(() => {
    useSettingsStore.getState().loadSettings()
    useUIStateStore.getState().loadUIState()
  }, [])
  const activeThemeId = useSettingsStore((s) => s.activeThemeId)
  const customThemes = useSettingsStore((s) => s.customThemes)
  const systemLightThemeId = useSettingsStore((s) => s.systemLightThemeId)
  const systemDarkThemeId = useSettingsStore((s) => s.systemDarkThemeId)
  // A detached AgentPanel routes provider sign-in to the main Cate Settings
  // (Providers); render the settings window here so that button works.
  const showSettings = useUIStore((s) => s.showSettings)
  const settingsInitialTab = useUIStore((s) => s.settingsInitialTab)
  const closeSettings = useUIStore((s) => s.closeSettings)
  useEffect(() => {
    applyTheme(activeThemeId)
  }, [activeThemeId, customThemes, systemLightThemeId, systemDarkThemeId])

  // Listen for DOCK_WINDOW_INIT from main process
  useEffect(() => {
    const cleanup = window.electronAPI.onDockWindowInit((payload: DockWindowInitPayload) => {
      // Main may create a dock window with an empty workspaceId (index.ts uses
      // `workspaceId ?? ''`). Fall back to a stable process-local id so the
      // appStore stub is actually created — otherwise ensurePanelsInAppStore
      // no-ops on '' and the window renders blank. The id is internal: it's
      // never sent back to main (dockWindowSyncState carries only zones/panels).
      const effectiveWs = payload.workspaceId || 'detached-dock-window'
      ensurePanelsInAppStore(effectiveWs, payload.panels)
      setWsId(effectiveWs)

      // Restore dock state. Panel locations are derived from the zones tree on
      // demand (dockStore.getPanelLocation), so there's nothing to rebuild.
      dockStore.getState().restoreSnapshot({
        zones: payload.dockState,
        locations: {},
      })
      setReady(true)
    })

    return cleanup
  }, [dockStore])

  // Editor Save-As inside this window already wrote the new filePath/title and
  // cleared isDirty straight into appStore (EditorPanel calls updatePanelFilePath
  // / setPanelDirty), which IS our source of truth — no local mirror needed.
  // We only force an immediate sync so a quit before the next 5s tick still
  // persists the saved file instead of a stale Untitled scratch buffer.
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ panelId: string; filePath: string; title: string }>
      if (!ce.detail?.panelId) return
      syncNowRef.current()
    }
    window.addEventListener('editor:panel-saved-as', handler)
    return () => window.removeEventListener('editor:panel-saved-as', handler)
  }, [])

  // Listen for incoming panel transfers (drag from other windows)
  useEffect(() => {
    const cleanup = window.electronAPI.onPanelReceive((snapshot: PanelTransferSnapshot) => {
      // Deposit transfer data BEFORE setting state (which triggers TerminalPanel mount)
      if (snapshot.terminalPtyId) {
        terminalRegistry.setPendingTransfer(snapshot.panel.id, snapshot.terminalPtyId, snapshot.terminalScrollback)
        // ACK is deferred to terminalRegistry.reconnectTerminal() after listeners are wired
      } else if (snapshot.terminalReplayPtyId && snapshot.panel.type === 'terminal') {
        // Session restore: spawn fresh PTY but replay the saved scrollback log
        terminalRestoreData.set(snapshot.panel.id, { replayFromId: snapshot.terminalReplayPtyId })
      }

      // Canvas panel: hydrate the per-panel canvas store BEFORE rendering, so
      // child nodes/regions are present on first paint. Without this the new
      // window mounts an empty canvas and writes that empty state back to
      // session persistence on the next sync. Also seed useAppStore with the
      // child PanelState records so the canvas's child nodes resolve to their
      // real types/titles instead of "Panel".
      if (snapshot.panel.type === 'canvas' && snapshot.canvasState) {
        const store = getOrCreateCanvasStoreForPanel(snapshot.panel.id)
        const { nodes, viewportOffset, zoomLevel, childPanels } = snapshot.canvasState
        store.getState().loadWorkspaceCanvas(nodes, viewportOffset, zoomLevel)
        ensurePanelsInAppStore(wsId, childPanels ?? {})
      }

      ensurePanelsInAppStore(wsId, { [snapshot.panel.id]: snapshot.panel })
    })

    return cleanup
  }, [wsId])

  // Set up cross-window drag listeners
  useEffect(() => {
    return setupCrossWindowDragListeners((snapshot, target) => {
      // Canvas-on-canvas is unsupported: refuse cross-window drops of a
      // canvas panel onto a canvas target.
      if (snapshot.panel.type === 'canvas' && target.kind !== 'dock') return

      // PTY transfer MUST be deposited before any state set that mounts TerminalPanel.
      if (snapshot.terminalPtyId) {
        terminalRegistry.setPendingTransfer(snapshot.panel.id, snapshot.terminalPtyId, snapshot.terminalScrollback)
      }

      // Canvas panel: hydrate before mount so children are visible immediately.
      if (snapshot.panel.type === 'canvas' && snapshot.canvasState) {
        const store = getOrCreateCanvasStoreForPanel(snapshot.panel.id)
        const { nodes, viewportOffset, zoomLevel, childPanels } = snapshot.canvasState
        store.getState().loadWorkspaceCanvas(nodes, viewportOffset, zoomLevel)
        ensurePanelsInAppStore(wsId, childPanels ?? {})
      }

      ensurePanelsInAppStore(wsId, { [snapshot.panel.id]: snapshot.panel })

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
  }, [dockStore])

  // Periodic state sync to main process for session persistence
  const syncNowRef = useRef<() => void>(() => {})
  useEffect(() => {
    const syncNow = () => {
      // Read panels straight from appStore at call time (not a closed-over
      // value) so the freshest live edits — url, isDirty, filePath written by
      // panel components — are always captured. wsId is read via a ref so this
      // closure never goes stale even though the effect doesn't depend on it.
      const currentPanels =
        useAppStore.getState().workspaces.find((w) => w.id === wsIdRef.current)?.panels ?? {}

      // Capture per-terminal ptyIds + persist their scrollback so the next
      // launch can replay it into a freshly spawned PTY.
      const terminalPtyIds: Record<string, string> = {}
      for (const panel of Object.values(currentPanels)) {
        if (panel.type !== 'terminal') continue
        const entry = terminalRegistry.getEntry(panel.id)
        if (!entry?.ptyId) continue
        terminalPtyIds[panel.id] = entry.ptyId

        // Exclude the cursor row: scrollback is replayed into a fresh PTY on the
        // next launch, which re-sends the prompt line.
        const content = terminalRegistry.captureScrollback(entry, { excludeCursorRow: true })
        if (content) {
          window.electronAPI.terminalScrollbackSave(entry.ptyId, content).catch(() => {})
        }
      }

      const snapshot = dockStore.getState().getSnapshot()
      window.electronAPI.dockWindowSyncState({
        ...snapshot,
        panels: currentPanels,
        terminalPtyIds,
      })
    }
    // Expose the latest syncNow via a ref so callers outside this effect
    // (the editor:panel-saved-as handler) can trigger an immediate sync
    // without waiting for the next 5-second interval / focus tick.
    syncNowRef.current = syncNow

    // Initial sync ~1s after panels are populated so main learns ptyIds quickly
    const initialSync = setTimeout(syncNow, 1000)
    syncTimerRef.current = setInterval(() => {
      if (document.visibilityState === 'visible') syncNow()
    }, 5000)

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') syncNow()
    }
    const handleFocus = () => syncNow()

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('focus', handleFocus)

    // Final sync before window closes to avoid losing state
    const handleBeforeUnload = () => syncNow()
    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      clearTimeout(initialSync)
      if (syncTimerRef.current) clearInterval(syncTimerRef.current)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [dockStore])

  // Render panel content inside canvas nodes (used by CanvasPanel's renderPanelContent)
  const renderPanelContent = useCallback(
    (panelId: string, nodeId: string, zoom: number) => {
      const panel = panels[panelId]
      if (!panel) return null

      const content = renderPanelComponent(panel, { workspaceId: wsId, nodeId, zoomLevel: zoom })
      if (!content) return null

      return (
        <Suspense fallback={<div className="w-full h-full bg-surface-4 flex items-center justify-center text-muted text-sm">Loading...</div>}>
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
          <Suspense fallback={<div className="w-full h-full bg-surface-4 flex items-center justify-center text-muted text-sm">Loading...</div>}>
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
    async (panelId: string) => {
      if (!(await confirmCloseDirtyPanels([panels[panelId]]))) return
      if (!(await confirmCloseRunningTerminals([panels[panelId]]))) return
      // Undock from THIS shell's own dock store, then drop only the panel
      // record from appStore (removePanelRecord — not removePanel, which would
      // target the workspace dock registry this shell doesn't use).
      dockStore.getState().undockPanel(panelId)
      const panel = panels[panelId]
      useAppStore.getState().removePanelRecord(wsId, panelId)

      if (panel?.type === 'terminal') {
        window.electronAPI.terminalKill(panelId).catch((err) => log.warn('[dock-window] Terminal kill failed:', err))
      }

      if (isDockEmpty(dockStore.getState())) {
        window.close()
      }
    },
    [dockStore, panels, wsId],
  )

  const handlePanelRenamed = useCallback(
    (panelId: string, title: string) => {
      useAppStore.getState().renamePanelByUser(wsId, panelId, title)
      syncNowRef.current()
    },
    [wsId],
  )

  const handlePanelRemoved = useCallback(
    (_panelId: string) => {
      if (isDockEmpty(dockStore.getState())) {
        window.close()
      }
    },
    [dockStore],
  )

  // Close the window when a programmatic undock (e.g. cross-window drag drop)
  // empties the dock store. handleClosePanel / handlePanelRemoved only fire
  // from UI paths; commit.ts bypasses them entirely.
  useEffect(() => {
    if (!ready) return
    const check = () => {
      const state = dockStore.getState()
      if (!hadPanelsRef.current) {
        if (!isDockEmpty(state) || Object.keys(panels).length > 0) {
          hadPanelsRef.current = true
        }
        return
      }
      if (shouldCloseDockWindow({ isDockEmpty: isDockEmpty(state), hasEverHadPanels: hadPanelsRef.current })) {
        window.close()
      }
    }
    check()
    const unsubscribe = dockStore.subscribe(check)
    return unsubscribe
  }, [dockStore, panels, ready])

  if (!ready) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-surface-4 text-muted">
        <div className="text-sm">Loading...</div>
      </div>
    )
  }

  return (
    <DockStoreProvider store={dockStore}>
      <div className="dock-window-root h-screen w-screen flex flex-col bg-surface-4 overflow-hidden">
        {/* Reserve 78px on the left of the top tab bar for the macOS traffic
            lights and make it the window drag region. Override inside any
            canvas-node ([data-node-id]) so nested mini-dock tab bars don't
            inherit the indent or become drag handles. */}
        <style>{`
          .dock-window-root .dock-tab-bar {
            padding-left: 78px;
            -webkit-app-region: drag;
          }
          .dock-window-root .dock-tab-bar > * { -webkit-app-region: no-drag; }
          .dock-window-root [data-node-id] .dock-tab-bar {
            padding-left: 0;
            -webkit-app-region: no-drag;
          }
        `}</style>
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
            onPanelRenamed={handlePanelRenamed}
          />
        </div>
        <DragOverlay />
        <SettingsWindow isOpen={showSettings} onClose={closeSettings} initialTab={settingsInitialTab ?? undefined} />
      </div>
    </DockStoreProvider>
  )
}

