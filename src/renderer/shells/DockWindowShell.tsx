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
import { applyCanvasChildPanels } from '../lib/canvas/applyCanvasChildPanels'
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

export default function DockWindowShell({ workspaceId: initialWorkspaceId }: DockWindowShellProps) {
  const [panels, setPanels] = useState<Record<string, PanelState>>({})
  // panelsRef shadows `panels` synchronously so callers that need to push
  // metadata to main immediately (e.g. an editor:panel-saved-as handler)
  // can read the freshly-computed map BEFORE React commits the state and
  // re-runs the periodic-sync effect that would otherwise refresh
  // syncNowRef's closure.
  const panelsRef = useRef<Record<string, PanelState>>({})
  const [wsId, setWsId] = useState(initialWorkspaceId ?? '')
  const [ready, setReady] = useState(false)
  const dockStore = useMemo(() => createDockStore(), [])
  const syncTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const hadPanelsRef = useRef(false)

  // Keep panelsRef in lock-step with the React state for the common path —
  // any synchronous updater that needs to ship its own new map updates the
  // ref inside its callback so the next syncNow can see it.
  panelsRef.current = panels

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

  // Editor Save-As inside this window updates the global appStore in the
  // detached renderer, but this shell maintains its own local `panels`
  // map (the source of truth for periodic session sync and close prompts).
  // Mirror the change so a saved scratch buffer becomes a real file in the
  // session record instead of being restored as Untitled on next launch.
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ panelId: string; filePath: string; title: string }>
      const { panelId, filePath, title } = ce.detail || ({} as never)
      if (!panelId) return
      // Mutate panelsRef synchronously alongside the React state update so
      // syncNow reads the post-Save-As snapshot regardless of whether the
      // periodic-sync effect has re-run yet. Without this, a setTimeout-
      // driven sync could still ship the pre-save map because React's
      // commit-then-effect cycle had not yet refreshed syncNowRef.
      setPanels((prev) => {
        const p = prev[panelId]
        if (!p) return prev
        const updated = { ...p, filePath, title, isDirty: false }
        const next = { ...prev, [panelId]: updated }
        panelsRef.current = next
        return next
      })
      // Now ship the new state to main. Without this, a quit before the
      // next 5s tick would persist the panel as untitled and a restart
      // would restore a stale scratch buffer instead of the saved file.
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
      // session persistence on the next sync. Also seed both local `panels`
      // and useAppStore with the child PanelState records so the canvas's
      // child nodes resolve to their real types/titles instead of "Panel".
      if (snapshot.panel.type === 'canvas' && snapshot.canvasState) {
        const store = getOrCreateCanvasStoreForPanel(snapshot.panel.id)
        const { nodes, regions, viewportOffset, zoomLevel, childPanels } = snapshot.canvasState
        store.getState().loadWorkspaceCanvas(nodes, viewportOffset, zoomLevel, null, regions)
        applyCanvasChildPanels(wsId, childPanels ?? {})
        if (childPanels) {
          setPanels((prev) => ({ ...prev, ...childPanels }))
        }
      }

      setPanels((prev) => ({
        ...prev,
        [snapshot.panel.id]: snapshot.panel,
      }))
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
        const { nodes, regions, viewportOffset, zoomLevel, childPanels } = snapshot.canvasState
        store.getState().loadWorkspaceCanvas(nodes, viewportOffset, zoomLevel, null, regions)
        applyCanvasChildPanels(wsId, childPanels ?? {})
        if (childPanels) {
          setPanels((prev) => ({ ...prev, ...childPanels }))
        }
      }

      setPanels((prev) => ({
        ...prev,
        [snapshot.panel.id]: snapshot.panel,
      }))

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
      // Read panels from the ref, not the closure: callers that mutate the
      // map (e.g. the Save-As handler) update panelsRef synchronously and
      // then invoke syncNow, expecting the freshly-written entries.
      const currentPanels = panelsRef.current

      // Capture per-terminal ptyIds + persist their scrollback so the next
      // launch can replay it into a freshly spawned PTY.
      const terminalPtyIds: Record<string, string> = {}
      for (const panel of Object.values(currentPanels)) {
        if (panel.type !== 'terminal') continue
        const entry = terminalRegistry.getEntry(panel.id)
        if (!entry?.ptyId) continue
        terminalPtyIds[panel.id] = entry.ptyId

        const buffer = entry.terminal.buffer.active
        const lastRow = buffer.baseY + buffer.cursorY
        const lines: string[] = []
        for (let i = 0; i < lastRow; i++) {
          const line = buffer.getLine(i)
          if (line) lines.push(line.translateToString(true))
        }
        while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
        const content = lines.join('\n')
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
  }, [dockStore, panels])

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
      dockStore.getState().undockPanel(panelId)
      setPanels((prev) => {
        const { [panelId]: _removed, ...rest } = prev
        return rest
      })

      const panel = panels[panelId]
      if (panel?.type === 'terminal') {
        window.electronAPI.terminalKill(panelId).catch((err) => log.warn('[dock-window] Terminal kill failed:', err))
      }

      if (isDockEmpty(dockStore.getState())) {
        window.close()
      }
    },
    [dockStore, panels],
  )

  const handlePanelRenamed = useCallback(
    (panelId: string, title: string) => {
      setPanels((prev) => {
        const p = prev[panelId]
        if (!p) return prev
        const next = { ...prev, [panelId]: { ...p, title } }
        panelsRef.current = next
        return next
      })
      syncNowRef.current()
    },
    [],
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
