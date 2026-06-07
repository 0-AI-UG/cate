// =============================================================================
// DockWindowShell — shell for detached dock windows.
// Each dock window has its own dock store, renders a center zone with full
// split/tab support. No sidebar, canvas, or left/right/bottom zones.
// =============================================================================

import React, { useEffect, useRef, useState, useCallback, Suspense, useMemo } from 'react'
import log from '../lib/logger'
import type { CanvasLayoutSnapshot, DockWindowInitPayload, PanelState, PanelTransferSnapshot } from '../../shared/types'
import { createDockStore } from '../stores/dockStore'
import { DockStoreProvider } from '../stores/DockStoreContext'
import DockZone from '../docking/DockZone'
import { DragOverlay, setupCrossWindowDragListeners } from '../drag'
import { terminalRegistry } from '../lib/terminal/terminalRegistry'
import { terminalRestoreData } from '../lib/workspace/session'
import { getOrCreateCanvasStoreForPanel } from '../stores/canvasStore'
import { ensurePanelsInAppStore } from '../lib/canvas/applyCanvasChildPanels'
import { hydrateReceivedPanel, hydrateCanvasState } from '../lib/panelTransfer'
import { useAppStore } from '../stores/appStore'
import { confirmCloseDirtyPanels } from '../lib/confirmCloseDirty'
import { confirmCloseRunningTerminals } from '../lib/confirmCloseTerminal'
import { isDockEmpty } from './dockEmpty'
import { shouldCloseDockWindow } from './shouldCloseDockWindow'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStateStore } from '../stores/uiStateStore'
import { useUIStore } from '../stores/uiStore'
import { SettingsWindow } from '../settings/SettingsWindow'
import WindowControls from './WindowControls'
import { applyTheme } from '../lib/themeManager'
import { applyUiScale } from '../lib/uiScale'

import { renderPanelComponent, PANEL_REGISTRY } from '../panels/registry'
const CanvasPanel = PANEL_REGISTRY.canvas.Component

const IS_MAC = navigator.userAgent.includes('Mac')

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
  const uiScale = useSettingsStore((s) => s.uiScale)
  useEffect(() => {
    applyUiScale(uiScale)
  }, [uiScale])

  // Listen for DOCK_WINDOW_INIT from main process
  useEffect(() => {
    const cleanup = window.electronAPI.onDockWindowInit((payload: DockWindowInitPayload) => {
      // Main may create a dock window with an empty workspaceId (index.ts uses
      // `workspaceId ?? ''`). Fall back to a stable process-local id so the
      // appStore stub is actually created — otherwise ensurePanelsInAppStore
      // no-ops on '' and the window renders blank. The id is internal: it's
      // never sent back to main (dockWindowSyncState carries only zones/panels).
      const effectiveWs = payload.workspaceId || 'detached-dock-window'
      ensurePanelsInAppStore(effectiveWs, payload.panels, payload.rootPath)

      // Session restore: seed scrollback replay for EVERY top-level terminal tab
      // and hydrate EVERY top-level canvas tab's children BEFORE the panels
      // mount. (A fresh live single-panel detach carries no replay/canvas data
      // here — it arrives via PANEL_RECEIVE instead.)
      if (payload.terminalReplayPtyIds) {
        for (const [panelId, ptyId] of Object.entries(payload.terminalReplayPtyIds)) {
          terminalRestoreData.set(panelId, { replayFromId: ptyId })
        }
      }
      if (payload.canvasStates) {
        for (const [canvasPanelId, canvasState] of Object.entries(payload.canvasStates)) {
          if (!canvasState) continue
          hydrateCanvasState(canvasPanelId, effectiveWs, canvasState)
        }
      }

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
      // Deposit PTY hand-off + hydrate canvas children BEFORE the panel mounts —
      // otherwise the window paints an empty canvas / a fresh shell and syncs
      // that empty state back to persistence. (ACK is deferred to
      // reconnectTerminal() after listeners are wired.)
      hydrateReceivedPanel(wsId, snapshot)
      ensurePanelsInAppStore(wsId, { [snapshot.panel.id]: snapshot.panel }, snapshot.rootPath)
    })

    return cleanup
  }, [wsId])

  // Set up cross-window drag listeners
  useEffect(() => {
    return setupCrossWindowDragListeners((snapshot, target) => {
      // Canvas-on-canvas is unsupported: refuse cross-window drops of a
      // canvas panel onto a canvas target.
      if (snapshot.panel.type === 'canvas' && target.kind !== 'dock') return

      // Deposit PTY hand-off + hydrate canvas children BEFORE the panel mounts.
      hydrateReceivedPanel(wsId, snapshot)
      ensurePanelsInAppStore(wsId, { [snapshot.panel.id]: snapshot.panel }, snapshot.rootPath)

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

      // Capture each canvas panel's layout (nodes + viewport) so a detached
      // canvas window restores its children on the next launch instead of
      // landing empty. The per-canvas store is process-local and otherwise
      // never persisted for detached windows.
      const canvasStates: Record<string, CanvasLayoutSnapshot> = {}
      for (const panel of Object.values(currentPanels)) {
        if (panel.type !== 'canvas') continue
        const cs = getOrCreateCanvasStoreForPanel(panel.id).getState()
        canvasStates[panel.id] = {
          nodes: cs.nodes,
          viewportOffset: cs.viewportOffset,
          zoomLevel: cs.zoomLevel,
        }
      }

      const snapshot = dockStore.getState().getSnapshot()
      window.electronAPI.dockWindowSyncState({
        ...snapshot,
        panels: currentPanels,
        terminalPtyIds,
        canvasStates,
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

  // Pre-quit: main requests a FINAL sync before it reads listDockWindows() for
  // the session file. Sync synchronously (fire the IPC) then ACK so main's cached
  // dock state isn't stale from the last 5s tick.
  useEffect(() => {
    const cleanup = window.electronAPI.onDockWindowFlushSync(() => {
      syncNowRef.current()
      window.electronAPI.dockWindowFlushSyncDone()
    })
    return cleanup
  }, [])

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
      <div className="dock-window-root relative h-screen w-screen flex flex-col bg-surface-4 overflow-hidden">
        {/* Make the top tab bar the window drag region. On macOS reserve 78px on
            the left for the traffic lights; on Windows/Linux reserve 132px on the
            right for our custom WindowControls overlay (below). Override inside any
            canvas-node ([data-node-id]) so nested mini-dock tab bars don't inherit
            the indent or become drag handles. */}
        <style>{`
          .dock-window-root .dock-tab-bar {
            ${IS_MAC ? 'padding-left: 78px;' : 'padding-right: 132px;'}
            -webkit-app-region: drag;
          }
          .dock-window-root .dock-tab-bar > * { -webkit-app-region: no-drag; }
          .dock-window-root [data-node-id] .dock-tab-bar {
            padding-left: 0;
            padding-right: 0;
            -webkit-app-region: no-drag;
          }
        `}</style>
        {/* Frameless Windows/Linux: custom window controls pinned to the top-right,
            over the tab bar's reserved right padding. */}
        {!IS_MAC && (
          <div className="absolute top-0 right-0 z-30 h-9">
            <WindowControls />
          </div>
        )}
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

