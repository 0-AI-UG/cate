// =============================================================================
// useShortcuts — Global keyboard shortcut listener hook.
// Ported from ShortcutHandler.swift + MainWindowView.installKeyMonitor
// =============================================================================

import { useEffect } from 'react'
import { useShortcutStore } from '../stores/shortcutStore'
import { useCanvasStoreApi } from '../stores/CanvasStoreContext'
import { useAppStore, getActiveCanvasOps } from '../stores/appStore'
import { useUIStore } from '../stores/uiStore'
import { useSearchStore } from '../stores/searchStore'
import type { MenuActionId, ShortcutAction } from '../../shared/types'
import { placementForActiveSurface } from '../lib/activeSurface'
import { confirmDeleteRegion } from '../lib/confirmDeleteRegion'
import { confirmClosePanels } from '../lib/confirmClosePanels'

// Cmd+Arrow panel navigation — moves the selection cursor between nodes.
const NAVIGATE_ACTIONS = new Set<ShortcutAction>([
  'navigateUp', 'navigateDown', 'navigateLeft', 'navigateRight',
])

// Shift+Arrow canvas panning.
const PAN_ACTIONS = new Set<ShortcutAction>([
  'panUp', 'panDown', 'panLeft', 'panRight',
])

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
    // Resolve the *active* canvas store at call time rather than binding to the
    // context store captured on mount. The visible canvas is a per-panel store
    // (CanvasPanel registers it and marks itself active via setActiveCanvasPanelId);
    // the App-level context only aliases the legacy singleton, which is usually
    // NOT the canvas the user is looking at once more than one canvas exists.
    // Routing every canvas action through the active store keeps keyboard
    // navigation/pan/zoom acting on the canvas actually on screen. Falls back to
    // the context store for single-canvas / detached windows.
    const canvasStore = () => (getActiveCanvasOps()?.storeApi ?? canvasStoreApi).getState()
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
      if (action === 'reloadWorkspace') {
        const { reloadActiveWorkspaceFromDisk } = await import('../lib/workspace/session')
        await reloadActiveWorkspaceFromDisk()
        return
      }
      if (action === 'manageLayouts') {
        useUIStore.getState().setShowLayoutsDialog(true)
        return
      }

      switch (action as ShortcutAction) {
        case 'newTerminal': {
          const placement = placementForActiveSurface()
          const wsId = await ensureWorkspaceFolder(selectedWorkspaceId)
          if (wsId) appStore().createTerminal(wsId, undefined, undefined, placement)
          break
        }
        case 'newBrowser': {
          const placement = placementForActiveSurface()
          const wsId = await ensureWorkspaceFolder(selectedWorkspaceId)
          if (wsId) appStore().createBrowser(wsId, undefined, undefined, placement)
          break
        }
        case 'newEditor':
        case 'newFile': {
          const placement = placementForActiveSurface()
          const wsId = await ensureWorkspaceFolder(selectedWorkspaceId)
          if (wsId) appStore().createEditor(wsId, undefined, undefined, placement)
          break
        }
        case 'closePanel': {
          const focusedNodeId = canvasStore().focusedNodeId
          if (focusedNodeId) {
            const node = canvasStore().nodes[focusedNodeId]
            if (node && (await confirmClosePanels(selectedWorkspaceId, [node.panelId]))) {
              appStore().closePanel(selectedWorkspaceId, node.panelId)
            }
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
        case 'toggleSearch': {
          const ui = useUIStore.getState()
          const side = ui.sidebarLayout.left.includes('search') ? 'left' : 'right'
          const active = side === 'left' ? ui.activeLeftSidebarView : ui.activeRightSidebarView
          const next = active === 'search' ? null : 'search'
          if (side === 'left') ui.setActiveLeftSidebarView(next)
          else ui.setActiveRightSidebarView(next)
          if (next === 'search') useSearchStore.getState().requestFocus()
          break
        }
        case 'toggleMinimap':
          useUIStore.getState().toggleMinimapOpen()
          break
        case 'nodeSwitcher':
          useUIStore.getState().setShowNodeSwitcher(true)
          break
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
        case 'zoomToSelection':
          canvasStore().zoomToSelection()
          break
        case 'toolSelect':
          useUIStore.getState().setActiveTool('select')
          break
        case 'toolHand':
          useUIStore.getState().setActiveTool('hand')
          break
        case 'navigateUp':
          canvasStore().navigateSelect('up')
          break
        case 'navigateDown':
          canvasStore().navigateSelect('down')
          break
        case 'navigateLeft':
          canvasStore().navigateSelect('left')
          break
        case 'navigateRight':
          canvasStore().navigateSelect('right')
          break
        case 'panUp':
          canvasStore().panViewport('up')
          break
        case 'panDown':
          canvasStore().panViewport('down')
          break
        case 'panLeft':
          canvasStore().panViewport('left')
          break
        case 'panRight':
          canvasStore().panViewport('right')
          break
        case 'autoLayout':
          canvasStore().autoLayout()
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
            if (await confirmClosePanels(selectedWorkspaceId, [node.panelId])) {
              appStore().closePanel(selectedWorkspaceId, node.panelId)
            }
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

    // A panel-creation shortcut fired while a detached dock/panel window was
    // focused is re-routed here (the main window owns the canvas). Make the
    // originating workspace active so the new panel is visible, then create it.
    const unsubscribeCreatePanel = window.electronAPI.onMenuCreatePanel(({ action, workspaceId }) => {
      if (workspaceId && appStore().getWorkspace(workspaceId) && appStore().selectedWorkspaceId !== workspaceId) {
        void appStore().selectWorkspace(workspaceId)
      }
      runAction(action).catch(() => { /* noop */ })
    })

    // Native "Layouts" menu → load a specific saved layout (replaces workspace).
    const unsubscribeLoadLayout = window.electronAPI.onMenuLoadLayout((name) => {
      import('../lib/layouts')
        .then((m) => m.loadLayoutReplacingWorkspace(name))
        .catch(() => { /* best-effort */ })
    })

    function handleKeyDown(e: KeyboardEvent) {
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

      // --- Spacebar-hold = temporary Hand tool (pan) ---
      // Hardcoded (a hold, not a tap). Ignored while typing or in a terminal so
      // Space still types a space. e.repeat guards against key-repeat spam.
      if (
        e.code === 'Space' &&
        !e.metaKey && !e.ctrlKey && !e.altKey &&
        !terminalHasFocus && !isTextSurfaceFocused()
      ) {
        if (!e.repeat) {
          e.preventDefault()
          useUIStore.getState().setSpacePanActive(true)
        }
        return
      }

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

      // Cmd+G — arrange selected nodes horizontally and wrap in a region
      if (e.metaKey && !e.shiftKey && e.key === 'g') {
        if (terminalHasFocus) return
        e.preventDefault()
        e.stopPropagation()
        canvasStore().groupSelectedHorizontal()
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

      // Escape — clear selection and revert to the Select tool (when no overlay
      // is open) so the user is never stuck in the Hand tool.
      if (e.key === 'Escape') {
        if (terminalHasFocus) return
        const ui = useUIStore.getState()
        if (!ui.showCommandPalette && !ui.showNodeSwitcher) {
          canvasStore().clearSelection()
          if (ui.activeTool !== 'select') ui.setActiveTool('select')
          // Don't prevent default — Escape might also close other things
          return
        }
      }

      // Delete/Backspace — delete selection
      // Skip when Cmd is held so Cmd+Backspace routes to the `deleteNode`
      // shortcut below (which deletes the currently focused panel).
      if ((e.key === 'Delete' || e.key === 'Backspace') && !e.metaKey) {
        if (terminalHasFocus) return
        // The sidebar (workspace list / file explorer) owns Delete/Backspace
        // when focused, so its own handler can delete the multi-selection.
        if (isSidebarKeyNavFocused()) return
        const state = canvasStore()
        if (state.selectedNodeIds.size > 0 || state.selectedRegionIds.size > 0) {
          // Don't delete if a text input is focused
          const active = document.activeElement
          const isEditable = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active?.getAttribute('contenteditable') === 'true'
          if (!isEditable) {
            e.preventDefault()
            e.stopPropagation()
            // When any selected region has panels inside, prompt the user
            // before destroying their work. Shift+Delete still bypasses the
            // prompt and deletes contents along with the region.
            const containedPanels = state.selectedRegionIds.size > 0
              ? Object.values(state.nodes).filter((n) => n.regionId && state.selectedRegionIds.has(n.regionId)).length
              : 0
            if (!e.shiftKey && containedPanels > 0) {
              confirmDeleteRegion(containedPanels).then((choice) => {
                if (choice === 'cancel') return
                canvasStore().deleteSelection(choice === 'with-contents')
              })
              return
            }
            // Shift+Delete deletes region contents too
            state.deleteSelection(e.shiftKey)
            return
          }
        }
      }

      // Enter — activate (focus) the selected-but-unfocused node. Cmd+Arrow
      // navigation selects + centres a node without grabbing keyboard focus so
      // jumps can be chained; Enter is the deliberate "step into this panel"
      // gesture. Skipped while typing, in a terminal, or when a list/overlay
      // owns the key, and only fires when exactly one node is selected and it
      // isn't already focused.
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        if (terminalHasFocus || isTextSurfaceFocused()) return
        if (isKeyNavFocused() || isSidebarKeyNavFocused()) return
        const uiNow = useUIStore.getState()
        if (uiNow.showCommandPalette || uiNow.showNodeSwitcher) return
        const state = canvasStore()
        if (state.selectedNodeIds.size === 1) {
          const id = [...state.selectedNodeIds][0]
          if (id !== state.focusedNodeId && state.nodes[id]) {
            e.preventDefault()
            e.stopPropagation()
            canvasStore().focusNode(id)
            return
          }
        }
      }

      // --- Shortcut matching ---
      const action = shortcutStore().matchEvent(e)
      if (!action) return

      // When panel switcher is open, only handle the toggle shortcut
      const ui = useUIStore.getState()

      // Tool shortcuts (Select/Hand) are ⌘⇧ combos, so they intentionally fire
      // even while a terminal/editor is focused — we intercept and preventDefault
      // before the surface sees the chord. No typing-suppression needed: a bare
      // letter is never consumed for tool switching.

      // Cmd+Arrow navigation / Shift+Arrow panning.
      if (NAVIGATE_ACTIONS.has(action) || PAN_ACTIONS.has(action)) {
        // Let an open overlay own the arrow keys.
        if (ui.showNodeSwitcher || ui.showCommandPalette) return
        // Let a keyboard-navigable list (e.g. the Search results tree, marked
        // data-keynav) keep its own arrow keys instead of moving the canvas.
        if (isKeyNavFocused()) return
        // Defer to a real text editor (Monaco / input / textarea /
        // contenteditable) so its own Cmd/Shift+Arrow editing keys keep
        // working. Terminals don't rely on those chords, so canvas navigation
        // overrides a focused terminal — letting the user jump/pan straight out
        // of one and keep going.
        if (!terminalHasFocus && isTextSurfaceFocused()) return
        // Navigating deliberately doesn't activate the destination, so drop
        // keyboard focus out of a focused terminal — otherwise its cursor keeps
        // capturing input and the next arrow never reaches the canvas.
        if (NAVIGATE_ACTIONS.has(action) && terminalHasFocus) {
          ;(document.activeElement as HTMLElement | null)?.blur()
        }
      }
      // Context-aware guard: when a real text editor (Monaco, input, textarea,
      // contenteditable) has focus, let Cmd+Z/Y fall through to it natively.
      // Terminals don't consume Cmd+Z/Y, so the canvas still owns undo/redo when
      // a terminal panel is focused.
      if (action === 'undo' || action === 'redo') {
        if (!terminalHasFocus && isTextSurfaceFocused()) return
      }
      // Cmd+Backspace (deleteNode): a focused terminal must keep the chord so the
      // shell can delete-to-line-start (translated to Ctrl+U in terminalRegistry),
      // and a focused text editor must keep it to delete text. Panels stay
      // closable via Cmd+W. Without this, the canvas would close the panel and
      // the keystroke would never reach the shell (issue #172).
      if (action === 'deleteNode') {
        if (terminalHasFocus || isTextSurfaceFocused()) return
        // Cmd+Backspace inside the sidebar deletes the selected workspaces/files
        // — let it bubble to the sidebar's own keydown handler instead of
        // closing a canvas panel.
        if (isSidebarKeyNavFocused()) return
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
      // Release the temporary Hand tool when Space is let go.
      if (e.code === 'Space') {
        useUIStore.getState().setSpacePanActive(false)
      }
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

    /** True when focus is inside a list that handles its own arrow keys (e.g.
     *  the Search results tree). Such surfaces opt out via `data-keynav` so the
     *  global canvas-navigation shortcuts don't steal their arrow keys. */
    function isKeyNavFocused(): boolean {
      const active = document.activeElement as HTMLElement | null
      return !!active?.closest('[data-keynav]')
    }

    /**
     * True when focus is inside a sidebar list that handles its own
     * Delete/Backspace (workspace list, file explorer). Those containers are
     * tagged with `data-sidebar-keynav`; when one is focused the global canvas
     * delete shortcuts must stand down so the list can delete its selection.
     */
    function isSidebarKeyNavFocused(): boolean {
      const active = document.activeElement as HTMLElement | null
      return !!active?.closest('[data-sidebar-keynav]')
    }

    document.addEventListener('keydown', handleKeyDown, { capture: true })
    document.addEventListener('keyup', handleKeyUp, { capture: true })

    // Handle window blur — clear the temporary Hand tool so a held Space can't
    // stick on Cmd-Tab.
    function handleBlur() {
      useUIStore.getState().setSpacePanActive(false)
    }

    window.addEventListener('blur', handleBlur)

    return () => {
      document.removeEventListener('keydown', handleKeyDown, { capture: true })
      document.removeEventListener('keyup', handleKeyUp, { capture: true })
      window.removeEventListener('blur', handleBlur)
      unsubscribeMenu()
      unsubscribeCreatePanel()
      unsubscribeLoadLayout()
    }
  }, [canvasStoreApi])
}
