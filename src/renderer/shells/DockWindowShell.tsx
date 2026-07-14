// =============================================================================
// DockWindowShell — shell for detached dock windows.
// Each dock window has its own dock store, renders a center zone with full
// split/tab support. No sidebar, canvas, or left/right/bottom zones.
// =============================================================================

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import type { CanvasLayoutSnapshot, DockWindowInitPayload, PanelState, PanelTransferSnapshot } from '../../shared/types'
import { createDockStore } from '../stores/dockStore'
import { DockStoreProvider } from '../stores/DockStoreContext'
import { registerWorkspaceDockStore } from '../lib/workspace/dockRegistry'
import DockZone from '../docking/DockZone'
import { setupCrossWindowDragListeners } from '../drag'
import { createRemoteDropHandler } from '../drag/crossWindow'
import { useFileDropTracker, FileDropOverlay } from '../drag/fileDropTarget'
import { captureTerminalScrollbacks } from './dockWindowSyncScrollback'
import { terminalRegistry } from '../lib/terminal/terminalRegistry'
import { getOrCreateCanvasStoreForPanel } from '../stores/canvasStore'
import { ensurePanelsInAppStore } from '../lib/canvas/applyCanvasChildPanels'
import { hydrateReceivedPanel, hydrateCanvasState } from '../lib/panelTransfer'
import { useAppStore } from '../stores/appStore'
import { closeDockWindowPanel } from './dockWindowClosePanel'
import { isDockEmpty } from './dockEmpty'
import { shouldCloseDockWindow } from './shouldCloseDockWindow'
import WindowControls from './WindowControls'
import { useWindowRuntime } from '../lib/hooks/useWindowRuntime'
import WindowChrome from './WindowChrome'
import DockWindowTitlebar from './DockWindowTitlebar'

import { PanelHost } from '../panels/PanelHost'
import { IS_MAC } from '../lib/platform'

interface DockWindowShellProps {
  workspaceId?: string
}

// Stable empty map so the appStore selector returns the same reference while a
// workspace is absent — avoids re-render churn and effect re-runs from a fresh
// `{}` each render.
const EMPTY: Record<string, PanelState> = {}

// Change-driven sync debounce: short enough that main's cache is effectively
// always fresh, long enough to coalesce a burst (drag rearranges, restores).
const SYNC_DEBOUNCE_MS = 500
// Periodic safety net — re-captures terminal scrollback, which accumulates
// without any store change.
const SYNC_INTERVAL_MS = 5000

export default function DockWindowShell({ workspaceId: initialWorkspaceId }: DockWindowShellProps) {
  const [wsId, setWsId] = useState(initialWorkspaceId ?? '')
  const [ready, setReady] = useState(false)
  const dockStore = useMemo(() => createDockStore(), [])
  const syncTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const hadPanelsRef = useRef(false)

  // Track file drags so docked extension panels can arm their webview drop overlay
  // (mirrors the main window — App.tsx installs the same tracker there).
  useFileDropTracker()

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

  // Shared window runtime — settings/theme, keyboard shortcuts, command palette,
  // agent-screen detector, Cmd+, settings, and the external-drop guard. Gives
  // this detached window the same baseline functionality as the main window.
  useWindowRuntime()

  // Listen for DOCK_WINDOW_INIT from main process
  useEffect(() => {
    const cleanup = window.electronAPI.onDockWindowInit((payload: DockWindowInitPayload) => {
      // Main may create a dock window with an empty workspaceId (index.ts uses
      // `workspaceId ?? ''`). Fall back to a stable process-local id so the
      // appStore stub is actually created — otherwise ensurePanelsInAppStore
      // no-ops on '' and the window renders blank. The id is internal: it's
      // never sent back to main (dockWindowSyncState carries only zones/panels).
      const effectiveWs = payload.workspaceId || 'detached-dock-window'
      // Update the ref SYNCHRONOUSLY: PANEL_RECEIVE arrives in the same IPC batch
      // right after this handler (dragHandlers sends INIT then RECEIVE), before
      // React re-renders with the new wsId state. Handlers read wsIdRef.current,
      // so it must be correct before this handler returns.
      wsIdRef.current = effectiveWs
      ensurePanelsInAppStore(effectiveWs, payload.panels, payload.rootPath, payload.worktrees)

      // Register THIS window's dock store under the effective workspace id so the
      // shared placement code (placePanel → getOrCreateWorkspaceDockStore) targets
      // it. Without this, panels created in this window (Cmd+T / palette) would be
      // docked into an orphan store and never appear.
      registerWorkspaceDockStore(effectiveWs, dockStore)

      // Session restore: arm scrollback replay for EVERY terminal panel (top-level
      // tabs AND canvas children — all are in payload.panels) by its stable panel
      // id, then hydrate each canvas tab's layout/children BEFORE the panels mount.
      // This mirrors the main window's restore (sessionRestore.ts) exactly: replay
      // reads `<panelId>.scrollback`, so it never depends on a captured live-ptyId
      // map that an early sync or a flush-less reload could leave empty.
      // (A fresh live detach sets no `restore` flag — its terminal arrives live via
      // PANEL_RECEIVE instead, so we must NOT arm replay for it here.)
      if (payload.restore) {
        for (const panel of Object.values(payload.panels)) {
          if (panel.type !== 'terminal') continue
          terminalRegistry.setPendingRestore(panel.id, payload.terminalCwds?.[panel.id])
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
      })
      setReady(true)
    })

    return cleanup
  }, [dockStore])

  // Listen for incoming panel transfers (drag from other windows). The handlers
  // read wsId via the ref, never a closed-over value: these effects register
  // once, and the INIT handler bumps wsIdRef.current synchronously, so a
  // transfer landing before React re-renders still targets the right workspace.
  useEffect(() => {
    const cleanup = window.electronAPI.onPanelReceive((snapshot: PanelTransferSnapshot) => {
      // Deposit PTY hand-off + hydrate canvas children BEFORE the panel mounts —
      // otherwise the window paints an empty canvas / a fresh shell and syncs
      // that empty state back to persistence. (ACK is deferred to
      // reconnectTerminal() after listeners are wired.)
      hydrateReceivedPanel(wsIdRef.current, snapshot)
      ensurePanelsInAppStore(wsIdRef.current, { [snapshot.panel.id]: snapshot.panel }, snapshot.rootPath, snapshot.worktrees)
    })

    return cleanup
  }, [])

  // Set up cross-window drag listeners
  useEffect(() => {
    return setupCrossWindowDragListeners(
      createRemoteDropHandler({
        addPanelStep: (snapshot) => {
          // Deposit PTY hand-off + hydrate canvas children BEFORE the panel mounts.
          hydrateReceivedPanel(wsIdRef.current, snapshot)
          ensurePanelsInAppStore(wsIdRef.current, { [snapshot.panel.id]: snapshot.panel }, snapshot.rootPath, snapshot.worktrees)
        },
      }),
    )
  }, [dockStore])

  // Periodic state sync to main process for session persistence.
  // Returns a promise that resolves once the terminal scrollback writes have
  // been persisted, so the pre-quit flush can AWAIT them before ACKing main
  // (otherwise main reallyExit(0)s before the fire-and-forget save lands and a
  // detached terminal loses its scrollback on restart). Periodic/focus callers
  // ignore the promise — the next tick re-writes.
  const syncNowRef = useRef<() => Promise<void>>(async () => {})
  useEffect(() => {
    const syncNow = async (): Promise<void> => {
      // Read panels straight from appStore at call time (not a closed-over
      // value) so the freshest live edits — url, isDirty, filePath written by
      // panel components — are always captured. wsId is read via a ref so this
      // closure never goes stale even though the effect doesn't depend on it.
      const currentPanels =
        useAppStore.getState().workspaces.find((w) => w.id === wsIdRef.current)?.panels ?? {}

      // Persist every terminal's scrollback (keyed by the stable panel id, same
      // as the main window) + capture each terminal's cwd. The save promises are
      // collected so the flush path can await them before ACKing quit.
      const { terminalCwds, savePromises } = await captureTerminalScrollbacks(currentPanels)

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

      // Send the snapshot under `dockState` (the field main caches and persists).
      // The payload carries no workspaceId by design (DockWindowSyncState cannot
      // express one): main owns the window→workspace mapping, set at creation.
      const snapshot = dockStore.getState().getSnapshot()
      window.electronAPI.dockWindowSyncState({
        dockState: snapshot,
        panels: currentPanels,
        terminalCwds,
        canvasStates,
      })

      // Resolve once every scrollback write has been persisted so the pre-quit
      // flush can await it. allSettled: a failed write must not reject the flush.
      await Promise.allSettled(savePromises)
    }
    // Expose the latest syncNow via a ref so callers outside this effect (the
    // rename handler, the pre-quit flush) can trigger an immediate sync.
    syncNowRef.current = syncNow

    // CHANGE-DRIVEN sync: any dock-layout or panel-state change schedules a
    // debounced sync, so main's cached view of this window is near-fresh at all
    // times instead of up to one period stale. This is what lets the pre-quit
    // flush be a safety net rather than a correctness requirement (e.g. an
    // editor Save-As writes appStore → lands here within the debounce).
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleSync = () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        syncNow()
      }, SYNC_DEBOUNCE_MS)
    }
    const unsubDock = dockStore.subscribe(scheduleSync)
    const unsubApp = useAppStore.subscribe((state, prev) => {
      const panels = state.workspaces.find((w) => w.id === wsIdRef.current)?.panels
      const prevPanels = prev.workspaces.find((w) => w.id === wsIdRef.current)?.panels
      if (panels !== prevPanels) scheduleSync()
    })

    // Initial sync ~1s after panels are populated so main learns ptyIds quickly
    const initialSync = setTimeout(syncNow, 1000)
    // Periodic safety net — terminal scrollback accumulates WITHOUT any store
    // change, so the change-driven path alone would never re-capture it.
    syncTimerRef.current = setInterval(() => {
      if (document.visibilityState === 'visible') syncNow()
    }, SYNC_INTERVAL_MS)

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
      if (debounceTimer) clearTimeout(debounceTimer)
      unsubDock()
      unsubApp()
      clearTimeout(initialSync)
      if (syncTimerRef.current) clearInterval(syncTimerRef.current)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [dockStore])

  // Sync as soon as the window is initialized (panels + dock state in place),
  // not just on the 1s timer. On session restore this is what lets main list
  // this window before the first autosave runs, so it isn't dropped from
  // session.json. Runs after the commit that set `ready`, so wsId/panels and
  // syncNowRef are current.
  useEffect(() => {
    if (ready) syncNowRef.current()
  }, [ready])

  // Pre-quit: main requests a FINAL sync before it reads listDockWindows() for
  // the session file. AWAIT the sync — specifically its terminal scrollback
  // writes — before ACKing, so main doesn't reallyExit(0) and kill the renderer
  // before the .scrollback files are persisted. Main bounds the wait with
  // DOCK_FLUSH_TIMEOUT_MS, so a stuck write can't hang quit. Without the await a
  // single-terminal detached window loses its scrollback on restart (it ACKs
  // fastest, so it is killed before its lone fire-and-forget write lands).
  useEffect(() => {
    const cleanup = window.electronAPI.onDockWindowFlushSync(() => {
      void syncNowRef.current().finally(() => {
        window.electronAPI.dockWindowFlushSyncDone()
      })
    })
    return cleanup
  }, [])

  // Render panel content for dock zones
  const renderPanel = useCallback(
    (panelId: string) => <PanelHost panelId={panelId} panels={panels} workspaceId={wsId} />,
    [panels, wsId],
  )

  const getPanelTitle = useCallback(
    (panelId: string) => panels[panelId]?.title ?? 'Panel',
    [panels],
  )

  const handleClosePanel = useCallback(
    async (panelId: string) => {
      if (!(await closeDockWindowPanel(wsId, panelId, dockStore))) return

      if (isDockEmpty(dockStore.getState())) {
        window.close()
      }
    },
    [dockStore, wsId],
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
        {/* macOS: DockWindowTitlebar (below) is the header + drag region and owns
            the traffic-light reservation, so the tab bar sits full-width beneath
            it with no indent or drag behavior of its own. Windows/Linux keep the
            tab bar AS the drag region and reserve 132px on the right for the
            custom WindowControls overlay. Override inside any canvas-node
            ([data-node-id]) so nested mini-dock tab bars don't inherit either. */}
        <style>{`
          ${IS_MAC ? '' : `
          .dock-window-root .dock-tab-bar {
            padding-right: 132px;
            -webkit-app-region: drag;
          }
          .dock-window-root .dock-tab-bar > * { -webkit-app-region: no-drag; }
          `}
          .dock-window-root [data-node-id] .dock-tab-bar {
            padding-left: 0;
            padding-right: 0;
            -webkit-app-region: no-drag;
          }
        `}</style>
        {/* macOS: conventional header/title bar (unlike the main window's floating
            island) — traffic-light reservation + drag region + active panel title.
            Collapses in native fullscreen. */}
        <DockWindowTitlebar workspaceId={wsId} />
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
        <WindowChrome />
        <FileDropOverlay />
      </div>
    </DockStoreProvider>
  )
}
