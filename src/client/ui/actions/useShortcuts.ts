// The window's keyboard: matches key presses against the resolved bindings
// (kernel/ui) and runs the bound action. Raw keys that are not shortcut
// actions (Space for the hand tool, Delete for the canvas selection) belong to
// the module that owns them, which registers a key handler.
//
// A focused panel whose definition `ownsKeyboard` (a shell) keeps the keys an
// editor would; a panel that `claimsShortcuts` an action handles it itself.

import { useEffect } from 'react'
import type { ShortcutAction } from '@kernel/ui/contract'
import { shortcutRegistry } from '@kernel/ui'
import { documentStoreFor } from '@client/document'
import { focusedLeafPanelId, panelDefinition } from '@client/host'
import type { PanelRecord } from '@workspace/document/contract'
import { desktopPort } from '../desktop'
import { useUIStore } from '../state/uiStore'
import { runAction } from './registry'

export interface KeyContext {
  /** The focused panel of the window's workspace, if any. */
  focusedPanel: PanelRecord | null
  /** The focused panel takes raw keystrokes (its definition `ownsKeyboard`). */
  keyboardOwned: boolean
  /** Focus is in an input, textarea or contenteditable. */
  textSurface: boolean
  /** A palette or overlay owns the keys. */
  overlayOpen: boolean
}

/** Returns true when it handled the key (the event then stops). */
export type KeyHandler = (event: KeyboardEvent, ctx: KeyContext) => boolean

const keyHandlers = new Set<KeyHandler>()

export function registerKeyHandler(handler: KeyHandler): () => void {
  keyHandlers.add(handler)
  return () => { keyHandlers.delete(handler) }
}

// Chords held down should not repeat these.
const NO_REPEAT = new Set<ShortcutAction>(['toggleTool', 'toggleKeepAwake', 'openWorktreeMenu', 'openConversationMenu', 'toggleCanvasToolbar'])
// Text surfaces keep these (native undo, word motion, text deletion).
const TEXT_KEEPS = new Set<ShortcutAction>(['undo', 'redo', 'panUp', 'panDown', 'panLeft', 'panRight', 'deleteNode', 'tidyGrid'])
// A panel that owns the keyboard (a shell) keeps these too (Cmd+Backspace
// deletes to line start in a shell).
const OWNED_KEEPS = new Set<ShortcutAction>(['deleteNode', 'tidyGrid'])
// An open palette or overlay owns the arrow keys.
const NAVIGATION = new Set<ShortcutAction>([
  'navigateUp', 'navigateDown', 'navigateLeft', 'navigateRight', 'panUp', 'panDown', 'panLeft', 'panRight', 'tidyGrid',
])

export function isTextSurfaceFocused(doc: Document = document): boolean {
  const active = doc.activeElement as HTMLElement | null
  if (!active) return false
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return true
  return active.getAttribute('contenteditable') === 'true' || !!active.closest('[contenteditable="true"]')
}

/** Focus is inside a list that handles its own Delete and arrows. */
function isSidebarKeyNavFocused(): boolean {
  return !!(document.activeElement as HTMLElement | null)?.closest('[data-sidebar-keynav]')
}

export function keyContext(): KeyContext {
  const ui = useUIStore.getState()
  const workspaceId = ui.selectedWorkspaceId
  const focusedId = workspaceId ? focusedLeafPanelId(workspaceId) : null
  const focusedPanel = workspaceId && focusedId ? documentStoreFor(workspaceId)?.getSnapshot().panels[focusedId] ?? null : null
  return {
    focusedPanel,
    keyboardOwned: !!(focusedPanel && panelDefinition(focusedPanel.type)?.ownsKeyboard),
    textSurface: isTextSurfaceFocused(),
    overlayOpen: ui.commandPaletteOpen || ui.overlay !== null,
  }
}

/** Whether a matched action should run here, or yield to what has focus. */
export function shouldRunShortcut(action: ShortcutAction, event: Pick<KeyboardEvent, 'repeat'>, ctx: KeyContext): boolean {
  if (event.repeat && NO_REPEAT.has(action)) return false
  if (ctx.overlayOpen && NAVIGATION.has(action)) return false
  if (ctx.textSurface && !ctx.keyboardOwned && TEXT_KEEPS.has(action)) return false
  if (ctx.keyboardOwned && OWNED_KEEPS.has(action)) return false
  if (action === 'deleteNode' && isSidebarKeyNavFocused()) return false
  const claims = ctx.focusedPanel ? panelDefinition(ctx.focusedPanel.type)?.claimsShortcuts : undefined
  return !claims?.includes(action)
}

export function handleShortcutKey(event: KeyboardEvent): void {
  const ctx = keyContext()
  for (const handler of [...keyHandlers]) {
    if (handler(event, ctx)) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
  }
  const action = shortcutRegistry().match(event)
  if (!action || !shouldRunShortcut(action, event, ctx)) return
  if (!runAction(action)) return
  event.preventDefault()
  event.stopPropagation()
}

/** Installs the window's shortcut listener and runs native menu picks.
 *  Mounted once per window by the shell. */
export function useShortcuts(): void {
  useEffect(() => {
    document.addEventListener('keydown', handleShortcutKey, { capture: true })
    const offMenu = desktopPort()?.onMenuAction((action) => { runAction(action) }) ?? (() => {})
    return () => {
      document.removeEventListener('keydown', handleShortcutKey, { capture: true })
      offMenu()
    }
  }, [])
}
