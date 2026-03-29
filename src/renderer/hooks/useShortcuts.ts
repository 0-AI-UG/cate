// =============================================================================
// useShortcuts — Global keyboard shortcut listener hook.
// Ported from ShortcutHandler.swift + MainWindowView.installKeyMonitor
// =============================================================================

import { useEffect } from 'react'
import { useShortcutStore } from '../stores/shortcutStore'
import { useCanvasStore } from '../stores/canvasStore'
import { useAppStore } from '../stores/appStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { useDockStore } from '../stores/dockStore'

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
  useEffect(() => {
    const shortcutStore = useShortcutStore.getState
    const canvasStore = useCanvasStore.getState
    const appStore = useAppStore.getState

    function handleKeyDown(e: KeyboardEvent) {
      // --- Modifier tracking (for hint overlay) ---
      updateModifierState(e)

      // Cancel hint hold on any keydown that isn't just a modifier
      if (!isModifierOnly(e)) {
        shortcutStore().cancelHintHold()
      }

      // --- Selection & region shortcuts (hardcoded) ---

      // Cmd+A — select all
      if (e.metaKey && !e.shiftKey && e.key === 'a') {
        // Don't select-all if a text input/editor is focused
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
        e.preventDefault()
        e.stopPropagation()
        canvasStore().groupSelectedIntoRegion()
        return
      }

      // Cmd+Shift+G — dissolve selected regions
      if (e.metaKey && e.shiftKey && e.key === 'G') {
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
        const ui = useUIStore.getState()
        if (!ui.showCommandPalette && !ui.showNodeSwitcher && !ui.showPanelSwitcher && !ui.showGlobalSearch) {
          canvasStore().clearSelection()
          // Don't prevent default — Escape might also close other things
          return
        }
      }

      // Delete/Backspace — delete selection
      if (e.key === 'Delete' || e.key === 'Backspace') {
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

      e.preventDefault()
      e.stopPropagation()

      const { selectedWorkspaceId } = appStore()

      switch (action) {
        case 'newTerminal':
          ensureWorkspaceFolder(selectedWorkspaceId).then((wsId) => {
            if (wsId) appStore().createTerminal(wsId)
          })
          break

        case 'newBrowser':
          ensureWorkspaceFolder(selectedWorkspaceId).then((wsId) => {
            if (wsId) appStore().createBrowser(wsId)
          })
          break

        case 'newEditor':
          ensureWorkspaceFolder(selectedWorkspaceId).then((wsId) => {
            if (wsId) appStore().createEditor(wsId)
          })
          break

        case 'closePanel': {
          // First check canvas focused node
          const focusedNodeId = canvasStore().focusedNodeId
          if (focusedNodeId) {
            const node = canvasStore().nodes[focusedNodeId]
            if (node) {
              appStore().closePanel(selectedWorkspaceId, node.panelId)
            }
            break
          }
          // If no canvas node focused, try closing the active docked panel
          const dockState = useDockStore.getState()
          for (const position of ['left', 'right', 'bottom'] as const) {
            const zone = dockState.zones[position]
            if (zone.panelIds.length > 0 && !zone.collapsed) {
              const activePanelId = zone.panelIds[zone.activePanelIndex]
              if (activePanelId) {
                appStore().closePanel(selectedWorkspaceId, activePanelId)
                break
              }
            }
          }
          break
        }

        case 'toggleSidebar':
          useUIStore.getState().toggleSidebar()
          break

        case 'toggleFileExplorer': {
          const ui = useUIStore.getState()
          if (ui.activeRightSidebarView === 'explorer') {
            ui.setActiveRightSidebarView(null)
          } else {
            ui.setActiveRightSidebarView('explorer')
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
            // Capture page screenshot BEFORE showing overlay
            window.electronAPI.capturePage().then((dataUrl) => {
              const ui = useUIStore.getState()
              ui.setShowPanelSwitcher(true)
              if (dataUrl) {
                useUIStore.setState({ panelSwitcherScreenshot: dataUrl })
              }
            }).catch(() => {
              useUIStore.getState().setShowPanelSwitcher(true)
            })
          }
          break
        }

        case 'commandPalette':
          useUIStore.getState().setShowCommandPalette(true)
          break

        case 'zoomIn':
        case 'zoomOut':
        case 'zoomReset': {
          // When a browser panel is focused, let zoom shortcuts pass through
          // to the webview so Cmd+=/- zoom the browser content, not the canvas.
          const focusedId = canvasStore().focusedNodeId
          const focusedNode = focusedId ? canvasStore().nodes[focusedId] : null
          const focusedPanel = focusedNode
            ? appStore().workspaces.find(w => w.id === selectedWorkspaceId)?.panels[focusedNode.panelId]
            : null
          if (focusedPanel?.type === 'browser') {
            // Don't prevent default — let the event reach the webview
            return
          }

          if (action === 'zoomIn') {
            canvasStore().animateZoomTo(canvasStore().zoomLevel + 0.1)
          } else if (action === 'zoomOut') {
            canvasStore().animateZoomTo(canvasStore().zoomLevel - 0.1)
          } else {
            canvasStore().animateZoomTo(1.0)
          }
          break
        }

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

        case 'toggleLeftDock':
          useDockStore.getState().toggleZoneCollapse('left')
          break

        case 'toggleRightDock':
          useDockStore.getState().toggleZoneCollapse('right')
          break

        case 'toggleBottomDock':
          useDockStore.getState().toggleZoneCollapse('bottom')
          break
      }
    }

    function handleKeyUp(e: KeyboardEvent) {
      updateModifierState(e)
    }

    /**
     * Push the current modifier state into the shortcut store.
     * The store handles hint hold start/stop logic internally.
     */
    function updateModifierState(e: KeyboardEvent) {
      shortcutStore().updateModifiers({
        command: e.metaKey,
        shift: e.shiftKey,
        option: e.altKey,
        control: e.ctrlKey,
      })
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
    }
  }, [])
}
