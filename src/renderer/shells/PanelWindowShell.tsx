// =============================================================================
// PanelWindowShell — borderless shell for detached panel windows.
// Renders a single panel with a custom title bar that serves as a drag handle.
// =============================================================================

import React, { useEffect, useState, useCallback, Suspense } from 'react'
import { X } from '@phosphor-icons/react'
import type { PanelState, PanelTransferSnapshot } from '../../shared/types'
import { terminalRegistry } from '../lib/terminal/terminalRegistry'
import { terminalRestoreData } from '../lib/workspace/session'
import { DragOverlay, setupCrossWindowDragListeners, useDragOp } from '../drag'
import { renderPanelComponent, getPanelDef } from '../panels/registry'
import { getOrCreateCanvasStoreForPanel } from '../stores/canvasStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStateStore } from '../stores/uiStateStore'
import { useUIStore } from '../stores/uiStore'
import { SettingsWindow } from '../settings/SettingsWindow'
import { applyTheme } from '../lib/themeManager'
import { ensurePanelsInAppStore } from '../lib/canvas/applyCanvasChildPanels'
import { useAppStore } from '../stores/appStore'

interface PanelWindowShellProps {
  panelType?: string
  panelId?: string
  workspaceId?: string
}

export default function PanelWindowShell({ panelType, panelId, workspaceId }: PanelWindowShellProps) {
  // Effective in-window workspace id for appStore. Main may launch a panel
  // window with no workspaceId, but ensurePanelsInAppStore no-ops on '' — which
  // would leave the panel unpopulated and the window stuck on "Loading". Fall
  // back to a stable process-local id used consistently for the appStore stub
  // AND the panel component (so its field writes land in the same workspace).
  // It stays in-window: panelWindowSyncMeta still reports the real prop
  // workspaceId, which main preserves (it keeps the creation-time id when the
  // caller passes none).
  const wsId = workspaceId || 'detached-panel-window'
  const [receivedSnapshot, setReceivedSnapshot] = useState<PanelTransferSnapshot | null>(null)
  // The transferred panel's id, captured when the snapshot arrives so we can
  // select the live panel record from appStore by id.
  const [livePanelId, setLivePanelId] = useState<string | null>(null)

  // appStore is this window's single source of truth: the transferred panel is
  // merged into a stub workspace, and the panel component writes its live
  // url/isDirty/filePath edits straight there. We select FROM appStore so those
  // edits are reflected here AND read by panelWindowSyncMeta on demand.
  const panel = useAppStore((s) =>
    livePanelId
      ? s.workspaces.find((w) => w.id === wsId)?.panels[livePanelId] ?? null
      : null,
  )

  // Hydrate settings + apply theme so this window mirrors the main app's
  // appearance and settings (theme, minimap, canvas grid, etc.).
  useEffect(() => {
    useSettingsStore.getState().loadSettings()
    useUIStateStore.getState().loadUIState()
  }, [])
  const activeThemeId = useSettingsStore((s) => s.activeThemeId)
  const customThemes = useSettingsStore((s) => s.customThemes)
  const systemLightThemeId = useSettingsStore((s) => s.systemLightThemeId)
  const systemDarkThemeId = useSettingsStore((s) => s.systemDarkThemeId)
  useEffect(() => {
    applyTheme(activeThemeId)
  }, [activeThemeId, customThemes, systemLightThemeId, systemDarkThemeId])

  // Listen for incoming panel transfers from the main process
  useEffect(() => {
    const cleanup = window.electronAPI.onPanelReceive((snapshot: PanelTransferSnapshot) => {
      // Deposit transfer data BEFORE setting state (which triggers TerminalPanel mount)
      if (snapshot.terminalPtyId) {
        terminalRegistry.setPendingTransfer(snapshot.panel.id, snapshot.terminalPtyId, snapshot.terminalScrollback)
      } else if (snapshot.terminalReplayPtyId && snapshot.panel.type === 'terminal') {
        // Session restore: no live PTY, but a previous run wrote a scrollback
        // log under this ptyId. Seed terminalRestoreData so getOrCreate runs
        // replayTerminalLog after spawning a fresh PTY.
        terminalRestoreData.set(snapshot.panel.id, { replayFromId: snapshot.terminalReplayPtyId })
      }

      // Canvas panel: hydrate the per-panel canvas store + child PanelStates.
      if (snapshot.panel.type === 'canvas' && snapshot.canvasState) {
        const store = getOrCreateCanvasStoreForPanel(snapshot.panel.id)
        const { nodes, viewportOffset, zoomLevel, childPanels } = snapshot.canvasState
        store.getState().loadWorkspaceCanvas(nodes, viewportOffset, zoomLevel)
        ensurePanelsInAppStore(wsId, childPanels ?? {})
      }

      ensurePanelsInAppStore(wsId, { [snapshot.panel.id]: snapshot.panel })
      setLivePanelId(snapshot.panel.id)
      setReceivedSnapshot(snapshot)
    })

    return cleanup
  }, [])

  // Editor Save-As inside this detached panel window already wrote the new
  // filePath/title and cleared isDirty straight into appStore (EditorPanel
  // calls updatePanelFilePath / setPanelDirty), which IS our source of truth.
  // We only push the fresh panel record to main so its window-registry meta —
  // which the session snapshot reads from — updates immediately rather than
  // waiting for the next transfer; otherwise the saved scratch buffer would be
  // restored as Untitled.
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ panelId: string; filePath: string; title: string }>
      const detail = ce.detail
      if (!detail?.panelId) return
      const current = useAppStore.getState().workspaces.find((w) => w.id === wsId)?.panels[detail.panelId]
      if (!current) return
      // Fire-and-forget — failure here only delays the meta update to the next
      // transfer, not data loss (the file itself is on disk).
      window.electronAPI.panelWindowSyncMeta?.({ panel: current, workspaceId }).catch(() => {})
    }
    window.addEventListener('editor:panel-saved-as', handler)
    return () => window.removeEventListener('editor:panel-saved-as', handler)
  }, [workspaceId])

  // For terminal panel windows: report ptyId to main + periodically save
  // scrollback so it can be replayed on next launch.
  useEffect(() => {
    if (!panel || panel.type !== 'terminal') return
    const panelId = panel.id

    let reportedPtyId: string | null = null

    const captureScrollback = (): void => {
      const entry = terminalRegistry.getEntry(panelId)
      if (!entry?.ptyId) return
      if (reportedPtyId !== entry.ptyId) {
        reportedPtyId = entry.ptyId
        window.electronAPI.panelWindowSyncPty(entry.ptyId).catch(() => {})
      }
      // Exclude the cursor row: scrollback is replayed into a fresh PTY on the
      // next launch, which re-sends the prompt line.
      const content = terminalRegistry.captureScrollback(entry, { excludeCursorRow: true })
      if (content) {
        window.electronAPI.terminalScrollbackSave(entry.ptyId, content).catch(() => {})
      }
    }

    // Wait for the terminal to be created before the first capture
    const initialDelay = setTimeout(captureScrollback, 1000)
    const interval = setInterval(captureScrollback, 5000)

    const handleBeforeUnload = (): void => captureScrollback()
    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      clearTimeout(initialDelay)
      clearInterval(interval)
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [panel])

  useEffect(() => {
    return setupCrossWindowDragListeners()
  }, [])

  const { handleDragStart } = useDragOp()

  // A detached AgentPanel routes provider sign-in to the main Cate Settings
  // (Providers). Render the settings window here too so that button works in
  // this window rather than being a no-op.
  const showSettings = useUIStore((s) => s.showSettings)
  const settingsInitialTab = useUIStore((s) => s.settingsInitialTab)
  const closeSettings = useUIStore((s) => s.closeSettings)

  // If we have panel info from query params but no transfer yet, show a loading state
  const displayPanel = panel

  const handleClose = useCallback(() => {
    window.close()
  }, [])

  /** Double-click title bar → dock panel back into main window */
  const handleTitleDoubleClick = useCallback(() => {
    window.electronAPI.panelWindowDockBack()
  }, [])

  /** Mousedown on the title bar starts a cross-window drag of this panel.
   *  When the cursor leaves the window, useDragOp emits cross-window-start,
   *  and the main process hands the cursor's snapshot to other windows. On a
   *  successful claim, commit's removeFromSource closes this window. */
  const handleTitleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!displayPanel) return
      if (e.button !== 0) return
      handleDragStart(e, {
        kind: 'panel-window',
        panelId: displayPanel.id,
        panelType: displayPanel.type,
        panelTitle: displayPanel.title ?? '',
        panel: displayPanel,
      })
    },
    [displayPanel, handleDragStart],
  )

  if (!displayPanel) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-surface-4 text-muted">
        <div className="text-sm">Loading panel...</div>
      </div>
    )
  }

  return (
    <div className="h-screen w-screen flex flex-col bg-surface-4 overflow-hidden">
      {/* Custom title bar.
       *  - Right side (title + close): -webkit-app-region: drag → OS-native
       *    window move (so the user can still reposition the panel window).
       *  - Left grip (panel icon): no-drag + onMouseDown → initiates a
       *    cross-window panel drag, so the user can dock this panel back
       *    into the main app or onto another Cate window. */}
      <div
        className="flex items-center h-8 px-2 bg-titlebar-bg border-b border-subtle select-none shrink-0"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        onDoubleClick={handleTitleDoubleClick}
      >
        <div
          className="flex items-center justify-center w-5 h-5 mr-1 rounded hover:bg-hover cursor-grab active:cursor-grabbing"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onMouseDown={handleTitleMouseDown}
          title="Drag to dock"
        >
          <PanelTypeIcon type={displayPanel.type} />
        </div>
        <span className="text-xs text-secondary truncate flex-1 min-w-0">{displayPanel.title}</span>
        <button
          className="w-5 h-5 flex items-center justify-center rounded hover:bg-hover text-muted hover:text-primary transition-colors"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onClick={handleClose}
          title="Close"
        >
          <X size={10} />
        </button>
      </div>

      <DragOverlay />

      {/* Panel content */}
      <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
        <Suspense fallback={<div className="w-full h-full bg-surface-4 flex items-center justify-center text-muted text-sm">Loading...</div>}>
          <PanelContent panel={displayPanel} workspaceId={wsId} />
        </Suspense>
      </div>

      <SettingsWindow isOpen={showSettings} onClose={closeSettings} initialTab={settingsInitialTab ?? undefined} />
    </div>
  )
}

// -----------------------------------------------------------------------------
// Panel content renderer
// -----------------------------------------------------------------------------

function PanelContent({ panel, workspaceId }: { panel: PanelState; workspaceId: string }) {
  const content = renderPanelComponent(panel, { workspaceId, nodeId: '' })
  if (!content) return <div className="w-full h-full flex items-center justify-center text-muted">Unknown panel type</div>
  return content
}

// -----------------------------------------------------------------------------
// Panel type icon
// -----------------------------------------------------------------------------

function PanelTypeIcon({ type }: { type: string }) {
  const Icon = getPanelDef(type).icon
  return <Icon size={14} className="text-muted" />
}
