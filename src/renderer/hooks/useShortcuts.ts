// =============================================================================
// useShortcuts — Global keyboard shortcut listener hook.
// Ported from ShortcutHandler.swift + MainWindowView.installKeyMonitor
// =============================================================================

import { useEffect } from 'react'
import { useShortcutStore } from '../stores/shortcutStore'
import { useCanvasStoreApi } from '../stores/CanvasStoreContext'
import { useAppStore } from '../stores/appStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import type { MenuActionId, ShortcutAction } from '../../shared/types'

/**
 * Ensures the workspace has a rootPath before proceeding.
 * If no rootPath is set, opens the folder dialog first.
 * Returns the workspaceId if ready, or null if the user cancelled.
 */
export async function ensureWorkspaceFolder(workspaceId: string): Promise<string | null> {
  const ws = useAppStore.getState().getWorkspace(workspaceId)
  if (ws?.rootPath) return workspaceId

  const folderPath = await window.electronAPI.openFolderDialog()
  if (!folderPath) return null

  useAppStore.getState().setWorkspaceRootPath(workspaceId, folderPath)
  return workspaceId
}

/**
 * Registers global keyboard shortcut listeners on `document`.
 *
 * Handles:
 * - Shortcut action dispatch (new panel, close, zoom, focus, etc.)
 * - Modifier key tracking for hint overlay (Cmd hold for 750ms)
 *
 * Must be called once at the top-level component (e.g. App.tsx).
 */
export function useShortcuts(): void {
  const canvasStoreApi = useCanvasStoreApi()

  useEffect(() => {
    const shortcutStore = useShortcutStore.getState
    const canvasStore = canvasStoreApi.getState
    const appStore = useAppStore.getState

    /**
     * Run a shortcut/menu action. Shared between the keyboard handler and the
     * native menu IPC listener, so the two code paths can never drift.
     * Re-reads store state at call time so it's safe to invoke at any moment.
     */
    async function runAction(action: MenuActionId): Promise<void> {
      const selectedWorkspaceId = appStore().selectedWorkspaceId

      // Menu-only actions first
      if (action === 'openFolder') {
        const folder = await window.electronAPI.openFolderDialog()
        if (folder) {
          useAppStore.getState().setWorkspaceRootPath(selectedWorkspaceId, folder)
        }
        return
      }

      switch (action as ShortcutAction) {
        case 'newTerminal': {
          const wsId = await ensureWorkspaceFolder(selectedWorkspaceId)
          if (wsId) appStore().createTerminal(wsId)
          break
        }
        case 'newBrowser': {
          const wsId = await ensureWorkspaceFolder(selectedWorkspaceId)
          if (wsId) appStore().createBrowser(wsId)
          break
        }
        case 'newEditor': {
          const wsId = await ensureWorkspaceFolder(selectedWorkspaceId)
          if (wsId) appStore().createEditor(wsId)
          break
        }
        case 'closePanel': {
          const focusedNodeId = canvasStore().focusedNodeId
          if (focusedNodeId) {
            const node = canvasStore().nodes[focusedNodeId]
            if (node) appStore().closePanel(selectedWorkspaceId, node.panelId)
          }
          break
        }
        case 'toggleSidebar':
          useUIStore.getState().toggleSidebar()
          break
        case 'toggleFileExplorer': {
          const ui = useUIStore.getState()
          const side = ui.sidebarLayout.left.includes('explorer') ? 'left' : 'right'
          if (side === 'left') {
            ui.setActiveLeftSidebarView(ui.activeLeftSidebarView === 'explorer' ? null : 'explorer')
          } else {
            ui.setActiveRightSidebarView(ui.activeRightSidebarView === 'explorer' ? null : 'explorer')
          }
          break
        }
        case 'toggleMinimap':
          useSettingsStore.getState().setSetting(
            'showMinimap',
            !useSettingsStore.getState().showMinimap,
          )
          break
        case 'nodeSwitcher':
          useUIStore.getState().setShowNodeSwitcher(true)
          break
        case 'panelSwitcher': {
          const uiState = useUIStore.getState()
          if (uiState.showPanelSwitcher) {
            window.dispatchEvent(new CustomEvent('panel-switcher-next'))
          } else {
            try {
              const dataUrl = await window.electronAPI.capturePage()
              const ui = useUIStore.getState()
              ui.setShowPanelSwitcher(true)
              if (dataUrl) useUIStore.setState({ panelSwitcherScreenshot: dataUrl })
            } catch {
              useUIStore.getState().setShowPanelSwitcher(true)
            }
          }
          break
        }
        case 'commandPalette':
          useUIStore.getState().setShowCommandPalette(true)
          break
        case 'zoomIn':
          canvasStore().animateZoomTo(canvasStore().zoomLevel + 0.1)
          break
        case 'zoomOut':
          canvasStore().animateZoomTo(canvasStore().zoomLevel - 0.1)
          break
        case 'zoomReset':
          canvasStore().animateZoomTo(1.0)
          break
        case 'focusNext': {
          const next = canvasStore().nextNode()
          if (next) canvasStore().focusNode(next)
          break
        }
        case 'focusPrevious': {
          const prev = canvasStore().previousNode()
          if (prev) canvasStore().focusNode(prev)
          break
        }
        case 'saveFile':
          window.dispatchEvent(new CustomEvent('save-file'))
          break
        case 'zoomToFit':
          canvasStore().zoomToFit()
          break
        case 'globalSearch':
          useUIStore.getState().setShowGlobalSearch(true)
          break
        case 'undo':
          canvasStore().undo()
          break
        case 'redo':
          canvasStore().redo()
          break
        case 'deleteNode': {
          const focusedId = canvasStore().focusedNodeId
          if (focusedId && canvasStore().nodes[focusedId]) {
            const node = canvasStore().nodes[focusedId]
            appStore().closePanel(selectedWorkspaceId, node.panelId)
          }
          break
        }
      }
    }

    // Subscribe to native-menu dispatches. The menu fires this on every File /
    // View / Terminal / etc. item that maps to a runnable action.
    const unsubscribeMenu = window.electronAPI.onMenuTriggerAction((action) => {
      runAction(action).catch(() => { /* noop — menu actions are best-effort */ })
    })

    function handleKeyDown(e: KeyboardEvent) {
      // --- Modifier tracking (for hint overlay) ---
      updateModifierState(e)

      // Cancel hint hold on any keydown that isn't just a modifier
      if (!isModifierOnly(e)) {
        shortcutStore().cancelHintHold()
      }

      // --- Detect whether a terminal panel is focused ---
      // When a terminal has focus, most keyboard events must pass through to
      // xterm.js. Only app-level shortcuts (Cmd+<key>, Ctrl+Tab, etc.) should
      // be intercepted; everything else belongs to the terminal.
      const { selectedWorkspaceId } = appStore()
      const focusedId = canvasStore().focusedNodeId
      const focusedNode = focusedId ? canvasStore().nodes[focusedId] : null
      const focusedPanel = focusedNode
        ? appStore().workspaces.find(w => w.id === selectedWorkspaceId)?.panels[focusedNode.panelId]
        : null
      const terminalHasFocus = focusedPanel?.type === 'terminal'

      // --- Selection & region shortcuts (hardcoded) ---

      // Cmd+A — select all
      if (e.metaKey && !e.shiftKey && e.key === 'a') {
        // Don't select-all if a text input/editor/terminal is focused
        if (terminalHasFocus) return
        const active = document.activeElement
        const isEditable = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active?.getAttribute('contenteditable') === 'true'
        if (!isEditable) {
          e.preventDefault()
          e.stopPropagation()
          canvasStore().selectAll()
          return
        }
      }

      // Cmd+G — group selected nodes into region
      if (e.metaKey && !e.shiftKey && e.key === 'g') {
        if (terminalHasFocus) return
        e.preventDefault()
        e.stopPropagation()
        canvasStore().groupSelectedIntoRegion()
        return
      }

      // Cmd+Shift+G — dissolve selected regions
      if (e.metaKey && e.shiftKey && e.key === 'G') {
        if (terminalHasFocus) return
        e.preventDefault()
        e.stopPropagation()
        const state = canvasStore()
        for (const regionId of state.selectedRegionIds) {
          canvasStore().dissolveRegion(regionId)
        }
        return
      }

      // Escape — clear selection (when no overlay is open)
      if (e.key === 'Escape') {
        if (terminalHasFocus) return
        const ui = useUIStore.getState()
        if (!ui.showCommandPalette && !ui.showNodeSwitcher && !ui.showPanelSwitcher && !ui.showGlobalSearch) {
          canvasStore().clearSelection()
          // Don't prevent default — Escape might also close other things
          return
        }
      }

      // Delete/Backspace — delete selection
      // Skip when Cmd is held so Cmd+Backspace routes to the `deleteNode`
      // shortcut below (which deletes the currently focused panel).
      if ((e.key === 'Delete' || e.key === 'Backspace') && !e.metaKey) {
        if (terminalHasFocus) return
        const state = canvasStore()
        if (state.selectedNodeIds.size > 0 || state.selectedRegionIds.size > 0) {
          // Don't delete if a text input is focused
          const active = document.activeElement
          const isEditable = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active?.getAttribute('contenteditable') === 'true'
          if (!isEditable) {
            e.preventDefault()
            e.stopPropagation()
            // Shift+Delete deletes region contents too
            state.deleteSelection(e.shiftKey)
            return
          }
        }
      }

      // --- Shortcut matching ---
      const action = shortcutStore().matchEvent(e)
      if (!action) return

      // When panel switcher is open, only handle the toggle shortcut
      const ui = useUIStore.getState()
      if (ui.showPanelSwitcher && action !== 'panelSwitcher') return

      // Context-aware guard: when a text surface (input, textarea, Monaco,
      // xterm helper textarea, contenteditable) has focus, let clipboard and
      // undo/redo fall through to it natively instead of the canvas.
      // Terminals don't consume Cmd+Z/Y/Backspace, so let canvas handle them
      // even when a terminal panel is focused. Only real text editors
      // (Monaco, inputs, contenteditables) should swallow them.
      if (action === 'undo' || action === 'redo' || action === 'deleteNode') {
        if (!terminalHasFocus && isTextSurfaceFocused()) return
      }

      // Keyboard-only passthrough: when a browser panel is focused, let
      // Cmd+=/- zoom the webview content instead of the canvas.
      if (action === 'zoomIn' || action === 'zoomOut' || action === 'zoomReset') {
        const focusedId = canvasStore().focusedNodeId
        const focusedNode = focusedId ? canvasStore().nodes[focusedId] : null
        const focusedPanel = focusedNode
          ? appStore().workspaces.find(w => w.id === selectedWorkspaceId)?.panels[focusedNode.panelId]
          : null
        if (focusedPanel?.type === 'browser') return
      }

      e.preventDefault()
      e.stopPropagation()

      runAction(action).catch(() => { /* noop */ })
    }

    function handleKeyUp(e: KeyboardEvent) {
      updateModifierState(e)
    }

    /**
     * Push the current modifier state into the shortcut store.
     * The store handles hint hold start/stop logic internally.
     */
    function updateModifierState(e: KeyboardEvent) {
      const prev = shortcutStore().activeModifiers
      const command = e.metaKey
      const shift = e.shiftKey
      const option = e.altKey
      const control = e.ctrlKey
      // Skip store update if nothing changed
      if (prev.command === command && prev.shift === shift && prev.option === option && prev.control === control) return
      shortcutStore().updateModifiers({ command, shift, option, control })
    }

    /**
     * Returns true if focus is inside an editable text surface — native
     * input/textarea (Monaco's inputarea and xterm's helper textarea both are
     * textareas), or a contenteditable element. Used to let Cmd+Z/Y/Backspace
     * fall through to the surface instead of triggering canvas actions.
     */
    function isTextSurfaceFocused(): boolean {
      const active = document.activeElement as HTMLElement | null
      if (!active) return false
      if (active instanceof HTMLInputElement) return true
      if (active instanceof HTMLTextAreaElement) return true
      if (active.getAttribute('contenteditable') === 'true') return true
      if (active.closest('[contenteditable="true"]')) return true
      return false
    }

    /**
     * Returns true if the event is ONLY a modifier key (no printable key).
     */
    function isModifierOnly(e: KeyboardEvent): boolean {
      return (
        e.key === 'Meta' ||
        e.key === 'Shift' ||
        e.key === 'Control' ||
        e.key === 'Alt'
      )
    }

    document.addEventListener('keydown', handleKeyDown, { capture: true })
    document.addEventListener('keyup', handleKeyUp, { capture: true })

    // Handle window blur — reset modifiers so hints don't get stuck
    function handleBlur() {
      shortcutStore().updateModifiers({
        command: false,
        shift: false,
        option: false,
        control: false,
      })
    }

    window.addEventListener('blur', handleBlur)

    return () => {
      document.removeEventListener('keydown', handleKeyDown, { capture: true })
      document.removeEventListener('keyup', handleKeyUp, { capture: true })
      window.removeEventListener('blur', handleBlur)
      unsubscribeMenu()
    }
  }, [canvasStoreApi])
}
