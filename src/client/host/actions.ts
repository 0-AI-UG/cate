// One path for menu, shortcut and command palette actions: every module
// registers the actions it owns (the canvas view its zoom and navigation, the
// client UI its dialogs), and callers run them by id. The host owns the panel
// actions: new panel of a type, close and rename the focused panel.

import { clientUi } from '@kernel/ui'
import type { PanelId } from '@workspace/document/contract'
import { closePanel } from './close'
import { createPanel } from './createPanel'
import { panelDefinitions } from './definitions'
import { focusedLeafPanelId, focusedPanelId } from './focus'

export interface ActionContext {
  /** The workspace the window shows, or null. */
  workspaceId: string | null
}

export type ActionHandler = (context: ActionContext) => void | Promise<void>

const handlers = new Map<string, ActionHandler>()

export function registerAction(id: string, handler: ActionHandler): () => void {
  handlers.set(id, handler)
  return () => { if (handlers.get(id) === handler) handlers.delete(id) }
}

export function hasAction(id: string): boolean {
  return handlers.has(id)
}

/** Runs an action; resolves false when nothing handles `id`. A failure is
 *  shown to the user. */
export async function runAction(id: string, context: ActionContext): Promise<boolean> {
  const handler = handlers.get(id)
  if (!handler) return false
  try {
    await handler(context)
  } catch (err) {
    clientUi().showError(err instanceof Error ? err.message : String(err))
  }
  return true
}

/** The action that creates a panel of `type` next to the focused panel. */
export const newPanelAction = (type: string): string => `new:${type}`

type RenameListener = (workspaceId: string, panelId: PanelId) => void
const renameListeners = new Set<RenameListener>()

/** Asks the dock showing the panel's tab to start an inline rename. */
export function requestPanelRename(workspaceId: string, panelId: PanelId): void {
  for (const listener of [...renameListeners]) listener(workspaceId, panelId)
}

export function onPanelRenameRequest(listener: RenameListener): () => void {
  renameListeners.add(listener)
  return () => { renameListeners.delete(listener) }
}

type PanelShortcutListener = (workspaceId: string, panelId: PanelId, action: string) => boolean
const panelShortcutListeners = new Set<PanelShortcutListener>()

/** Hands an action the panel's definition `claimsShortcuts` to its view (a
 *  native menu pick; keys reach the focused view directly). True when a view
 *  handled it. */
export function requestPanelShortcut(workspaceId: string, panelId: PanelId, action: string): boolean {
  let handled = false
  for (const listener of [...panelShortcutListeners]) handled = listener(workspaceId, panelId, action) || handled
  return handled
}

export function onPanelShortcut(listener: PanelShortcutListener): () => void {
  panelShortcutListeners.add(listener)
  return () => { panelShortcutListeners.delete(listener) }
}

/** Registers `new:<type>` for every definition, `closePanel` and
 *  `renamePanel`. Returns a function that removes them. */
export function registerHostActions(): () => void {
  const stops = [
    ...panelDefinitions().map((definition) => registerAction(newPanelAction(definition.type), ({ workspaceId }) => {
      if (!workspaceId) return
      createPanel(workspaceId, definition.type, { near: focusedPanelId(workspaceId) ?? undefined })
    })),
    registerAction('closePanel', async ({ workspaceId }) => {
      const panelId = workspaceId ? focusedLeafPanelId(workspaceId) : null
      if (workspaceId && panelId) await closePanel(workspaceId, panelId)
    }),
    registerAction('renamePanel', ({ workspaceId }) => {
      const panelId = workspaceId ? focusedLeafPanelId(workspaceId) : null
      if (workspaceId && panelId) requestPanelRename(workspaceId, panelId)
    }),
  ]
  return () => { for (const stop of stops) stop() }
}
