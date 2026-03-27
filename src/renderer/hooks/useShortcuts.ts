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
          appStore().createTerminal(selectedWorkspaceId)
          break

        case 'newBrowser':
          appStore().createBrowser(selectedWorkspaceId)
          break

        case 'newEditor':
          appStore().createEditor(selectedWorkspaceId)
          break

        case 'closePanel': {
          const focusedNodeId = canvasStore().focusedNodeId
          if (focusedNodeId) {
            const node = canvasStore().nodes[focusedNodeId]
            if (node) {
              appStore().closePanel(selectedWorkspaceId, node.panelId)
            }
          }
          break
        }

        case 'toggleSidebar':
          useUIStore.getState().toggleSidebar()
          break

        case 'toggleFileExplorer':
          useUIStore.getState().toggleFileExplorer()
          break

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
          useCanvasStore.getState().zoomAroundCenter(useCanvasStore.getState().zoomLevel + 0.1)
          break

        case 'zoomOut':
          useCanvasStore.getState().zoomAroundCenter(useCanvasStore.getState().zoomLevel - 0.1)
          break

        case 'zoomReset':
          useCanvasStore.getState().zoomAroundCenter(1.0)
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
