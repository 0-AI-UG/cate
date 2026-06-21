// =============================================================================
// useShortcuts — Global keyboard shortcut listener hook.
// Ported from ShortcutHandler.swift + MainWindowView.installKeyMonitor
// =============================================================================

import { useEffect } from 'react'
import { useShortcutStore } from '../stores/shortcutStore'
import { useCanvasStoreApi } from '../stores/CanvasStoreContext'
import {
  useAppStore,
  getActiveCanvasOps,
  getActiveCanvasPanelId,
  getWorkspaceCanvasStore,
} from '../stores/appStore'
import { useUIStore } from '../stores/uiStore'
import { getActivePanelId, setActivePanel } from '../lib/activePanel'
import { resolvePanelById } from '../lib/workspace/panelReveal'
import { getNodeActivePanelId } from '../panels/nodeDockRegistry'
import { focusedNodeId as focusedNodeIdOf } from '../stores/canvas/selectionModel'
import type { ShortcutAction } from '../../shared/types'
import { runAction } from '../lib/runAction'

// ensureWorkspaceFolder lives in lib/runAction now; re-exported here for the
// panels/pages that still import it from this module.
export { ensureWorkspaceFolder } from '../lib/runAction'

// Cmd+Arrow panel navigation — moves the selection cursor between nodes.
const NAVIGATE_ACTIONS = new Set<ShortcutAction>([
  'navigateUp', 'navigateDown', 'navigateLeft', 'navigateRight',
])

// Shift+Arrow canvas panning.
const PAN_ACTIONS = new Set<ShortcutAction>([
  'panUp', 'panDown', 'panLeft', 'panRight',
])

/**
 * Whether a terminal panel currently holds input focus, derived from the
 * canonical active-panel pointer (lib/activePanel). When a terminal is focused,
 * most keystrokes must pass through to xterm.js, so the shortcut handler uses
 * this to bail out of non-Cmd shortcuts.
 *
 * Primary path: the active panel id resolves to a `terminal` panel → true.
 * Fallback: the active id is a CANVAS container (a canvas is itself the active
 * panel when a node was focused only via the canvas), so descend into the
 * focused node's per-node dock to find its active leaf panel, and check that.
 * This is what fixes the old `node.panelId` (seed panel) bug — a node holding a
 * terminal tab beside an editor now reports correctly per the visible tab.
 *
 * Exported (and pure — reads only module/store state) so it can be unit-tested.
 */
export function computeTerminalHasFocus(): boolean {
  const activeId = getActivePanelId()
  if (!activeId) return false

  const activePanel = resolvePanelById(activeId)
  if (activePanel?.type === 'terminal') return true

  // Canvas container active: the real input-focus panel is the focused node's
  // active dock leaf. Resolve via the active canvas store's focusedNodeId.
  if (activePanel?.type === 'canvas') {
    const canvasPanelId = getActiveCanvasPanelId()
    if (!canvasPanelId) return false
    const canvasStore =
      getActiveCanvasOps()?.storeApi ??
      getWorkspaceCanvasStore(useAppStore.getState().selectedWorkspaceId)
    const state = canvasStore?.getState()
    const focusedNodeId = state ? focusedNodeIdOf(state) : null
    if (!focusedNodeId) return false
    const leafId = getNodeActivePanelId(canvasPanelId, focusedNodeId)
    if (!leafId) return false
    return resolvePanelById(leafId)?.type === 'terminal'
  }

  return false
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
    // context store captured on mount. The visible canvas is a per-panel store;
    // getActiveCanvasOps derives it from the canonical active panel (see
    // lib/activePanel + canvasAccess), falling back to the workspace's primary
    // canvas. The App-level context only aliases the legacy singleton, which is
    // usually NOT the canvas the user is looking at once more than one exists.
    // Routing every canvas action through the active store keeps keyboard
    // navigation/pan/zoom acting on the canvas actually on screen. Falls back to
    // the context store for single-canvas / detached windows.
    const canvasStore = () => (getActiveCanvasOps()?.storeApi ?? canvasStoreApi).getState()
    const appStore = useAppStore.getState

    // Subscribe to native-menu dispatches. The menu fires this on every File /
    // View / Terminal / etc. item that maps to a runnable action.
    const unsubscribeMenu = window.electronAPI.onMenuTriggerAction((action) => {
      runAction(action, canvasStoreApi).catch(() => { /* noop — menu actions are best-effort */ })
    })

    // Native "Layouts" menu → load a saved layout into the active canvas.
    const unsubscribeLoadLayout = window.electronAPI.onMenuLoadLayout((name) => {
      import('../lib/layouts')
        .then((m) => m.loadLayoutIntoActiveCanvas(name))
        .catch(() => { /* best-effort */ })
    })

    function handleKeyDown(e: KeyboardEvent) {
      // --- Detect whether a terminal panel is focused ---
      // When a terminal has focus, most keyboard events must pass through to
      // xterm.js. Only app-level shortcuts (Cmd+<key>, Ctrl+Tab, etc.) should
      // be intercepted; everything else belongs to the terminal.
      const terminalHasFocus = computeTerminalHasFocus()

      // --- Bare Space = toggle the Select / Hand tool (canvas convenience) ---
      // Ignored while typing or in a terminal so Space still types a space, and
      // skipped when an overlay owns the key. ⇧Space is handled via the matched
      // `toggleTool` action below so it can also fire over a focused surface, so
      // exclude Shift here. e.repeat guards against key-repeat spam.
      if (
        e.code === 'Space' &&
        !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey &&
        !terminalHasFocus && !isTextSurfaceFocused()
      ) {
        const uiNow = useUIStore.getState()
        if (!e.repeat && !uiNow.showCommandPalette) {
          e.preventDefault()
          uiNow.setActiveTool(uiNow.activeTool === 'hand' ? 'select' : 'hand')
        }
        return
      }

      // --- Selection shortcuts (hardcoded) ---

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

      // Cmd+G — tidy the selected nodes into a grid
      if (e.metaKey && !e.shiftKey && e.key === 'g') {
        if (terminalHasFocus) return
        e.preventDefault()
        e.stopPropagation()
        canvasStore().tidyGridSelected()
        return
      }

      // Escape — clear selection and revert to the Select tool (when no overlay
      // is open) so the user is never stuck in the Hand tool.
      if (e.key === 'Escape') {
        if (terminalHasFocus) return
        const ui = useUIStore.getState()
        if (!ui.showCommandPalette) {
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
        if (state.selection.length > 0) {
          // Don't delete if a text input is focused
          const active = document.activeElement
          const isEditable = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active?.getAttribute('contenteditable') === 'true'
          if (!isEditable) {
            e.preventDefault()
            e.stopPropagation()
            state.deleteSelection()
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
        if (uiNow.showCommandPalette) return
        const state = canvasStore()
        if (state.selection.length === 1) {
          const id = state.selection[0]
          if (id !== focusedNodeIdOf(state) && state.nodes[id]) {
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

      const ui = useUIStore.getState()

      // toggleTool (⌃Space by default) intentionally has no typing-suppression
      // guard: it's the gesture that switches Select/Hand even while a
      // terminal/editor/input is focused. The capture-phase preventDefault below
      // stops the surface from seeing it. Ignore key-repeat so a held chord
      // doesn't flicker between tools.
      if (action === 'toggleTool' && e.repeat) return

      // Cmd+Arrow navigation / Shift+Arrow panning.
      if (NAVIGATE_ACTIONS.has(action) || PAN_ACTIONS.has(action)) {
        // Let an open overlay own the arrow keys.
        if (ui.showCommandPalette) return
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
        // capturing input and the next arrow never reaches the canvas. Also
        // repoint the canonical active panel at the canvas itself: the leaf
        // pointer otherwise stays on the terminal, so computeTerminalHasFocus
        // keeps reporting a focused terminal and bare-key shortcuts (Enter to
        // activate the jump target, Delete, Escape) wrongly stand down.
        if (NAVIGATE_ACTIONS.has(action) && terminalHasFocus) {
          ;(document.activeElement as HTMLElement | null)?.blur()
          setActivePanel(getActiveCanvasPanelId())
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
        const focusedId = focusedNodeIdOf(canvasStore())
        const focusedNode = focusedId ? canvasStore().nodes[focusedId] : null
        const focusedPanel = focusedNode
          ? appStore().workspaces.find(w => w.id === appStore().selectedWorkspaceId)?.panels[focusedNode.panelId]
          : null
        if (focusedPanel?.type === 'browser') return
      }

      e.preventDefault()
      e.stopPropagation()

      runAction(action, canvasStoreApi).catch(() => { /* noop */ })
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

    return () => {
      document.removeEventListener('keydown', handleKeyDown, { capture: true })
      unsubscribeMenu()
      unsubscribeLoadLayout()
    }
  }, [canvasStoreApi])
}
