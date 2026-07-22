// =============================================================================
// useWindowRuntime — the shared "app shell runtime" every Cate window mounts.
//
// Each renderer window (main, detached dock, detached panel) is a separate JS
// context, so the stores and module state the behaviors below touch are already
// per-window. This hook is the single place those window-agnostic behaviors are
// wired, so a new window type gains them for free by calling it once — instead of
// every shell hand-wiring shortcuts, the agent detector, the settings-open
// listener, and the drop guard (which is how detached windows fell behind the
// main window in the first place).
//
// Genuinely main-only behavior (session init, process monitor, sidebars, OS
// title sync, "Open With Cate", dock-back receiver, perf/E2E) stays in App.tsx's
// MainApp and is intentionally NOT moved here.
// =============================================================================

import { useEffect } from 'react'
import { useShortcuts } from '../../hooks/useShortcuts'
import { useThemeAndScaleHydration } from './useThemeAndScaleHydration'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStateStore } from '../../stores/uiStateStore'
import { useUIStore } from '../../stores/uiStore'
import { useAppStore } from '../../stores/appStore'
import { useWindowPanelStore } from '../../stores/windowPanelStore'
import {
  startAgentScreenDetector,
  stopAgentScreenDetector,
  applyRemoteAgentScreenState,
  noteAgentHookEvent,
} from '../agent/agentScreenDetector'
import { isExternalFileDrag } from '../fs/importExternalEntries'
import { revealPanel } from '../workspace/panelReveal'
import { closePanelWithConfirm } from '../closePanelWithConfirm'
import { setupWindowPanelSync } from '../workspace/windowPanelSync'
import { useOwnedTerminalTelemetry } from '../../hooks/useProcessMonitor'
import type { AgentState } from '../../../shared/types'
import type { StoreApi } from 'zustand'
import type { CanvasStore } from '../../stores/canvasStore'

export function useWindowRuntime(canvasStore?: StoreApi<CanvasStore>): void {
  // Appearance: hydrate settings + UI state, then apply theme + scale on change.
  // The main App loads these inside its awaited init effect; calling them here
  // too is idempotent (the stores no-op a redundant load), so every window mounts
  // the same way.
  useEffect(() => {
    useSettingsStore.getState().loadSettings()
    useUIStateStore.getState().loadUIState()
  }, [])
  useThemeAndScaleHydration()

  // Keyboard shortcuts + native-menu dispatch (MENU_TRIGGER_ACTION etc.). All of
  // its canvas/active-panel resolution is per-window, so it acts on the in-window
  // canvas and panels.
  useShortcuts(canvasStore)

  // Owner-routed terminal telemetry (agent presence/name, ports, cwd). Main
  // sends these only to each terminal's owning window, so every window must
  // listen for its OWN terminals — otherwise a detached terminal never learns
  // its agent presence and the detector can't flip it to `running` (hook
  // events alone aren't enough; resolveAgentState gates running on presence).
  useOwnedTerminalTelemetry()

  // Agent activity coordinator: derives running/"needs input" state from agent
  // hook events and reports it via IPC. Hook events arrive only in the
  // terminal's OWNING window
  // (SHELL_AGENT_HOOK_EVENT), so every window feeds its own; the screen-state
  // broadcast below mirrors the result so other windows' sidebars agree.
  // Without starting it here, detached terminals never report agent state.
  useEffect(() => {
    startAgentScreenDetector()
    const offRemote = window.electronAPI?.onAgentScreenStateUpdate?.(
      (terminalId: string, state: AgentState) => {
        applyRemoteAgentScreenState(terminalId, state)
      },
    )
    const offHook = window.electronAPI?.onShellAgentHookEvent?.((_terminalId, event) => {
      noteAgentHookEvent(event)
    })
    return () => {
      stopAgentScreenDetector()
      offRemote?.()
      offHook?.()
    }
  }, [])

  // Cmd+, / Settings menu item → toggle the (already-mounted) SettingsWindow.
  useEffect(() => {
    return window.electronAPI.onMenuOpenSettings?.(() => {
      const ui = useUIStore.getState()
      if (ui.showSettings) ui.closeSettings()
      else ui.openSettings()
    })
  }, [])

  // Swallow stray EXTERNAL (OS) file drops on the window background so Chromium
  // doesn't navigate to the file:// URL. Inner drop targets (file explorer, dock,
  // agent) call stopPropagation, so those never reach this capture-phase listener.
  // A window-level listener (vs a React root handler) covers every window's chrome
  // uniformly, including the detached shells.
  useEffect(() => {
    const onDragOver = (e: DragEvent): void => {
      if (!e.dataTransfer || !isExternalFileDrag(e as unknown as React.DragEvent)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'none'
    }
    const onDrop = (e: DragEvent): void => {
      if (!e.dataTransfer || !isExternalFileDrag(e as unknown as React.DragEvent)) return
      e.preventDefault()
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  // Cross-window panel union: every window subscribes so its overview + command
  // palette can list panels that live in OTHER windows, AND reports its own panels
  // (setupWindowPanelSync) so other windows can discover them — one symmetric path
  // for every window type.
  useEffect(() => {
    const stopReporting = setupWindowPanelSync()
    const unsubscribe = window.electronAPI.onWindowPanelsChanged?.((panels) => {
      useWindowPanelStore.getState().setPanels(panels)
    })
    return () => {
      stopReporting()
      unsubscribe?.()
    }
  }, [])

  // Cross-window reveal: main asks the window that owns a panel to bring it
  // forward (see focusWindowPanel). The panel may belong to a workspace other
  // than the active one (a main window hosts many), so resolve its real workspace
  // before revealing — revealPanel switches to it if needed.
  useEffect(() => {
    return window.electronAPI.onRevealPanelInWindow?.((panelId: string) => {
      const app = useAppStore.getState()
      const owner = app.workspaces.find((w) => panelId in w.panels)
      const wsId = owner?.id ?? app.selectedWorkspaceId
      void revealPanel(wsId, panelId, { retry: true })
    })
  }, [])

  // Cross-window close: another window's overview asked to close a panel this
  // window owns. Runs the same confirm gates as any local close affordance.
  useEffect(() => {
    return window.electronAPI.onClosePanelInWindow?.((panelId: string) => {
      const app = useAppStore.getState()
      const owner = app.workspaces.find((w) => panelId in w.panels)
      if (!owner) return
      void closePanelWithConfirm(owner.id, panelId)
    })
  }, [])
}
