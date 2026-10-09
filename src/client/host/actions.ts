// The one action registry: every key, menu item, palette entry and toolbar
// button runs an action by id. A module declares its actions (kernel/interaction's
// catalog: title, default key, menu placement) and binds what they do in one
// `registerActions` call; panel types get theirs from their definitions
// (panelActions.ts). The host also owns the panel rename and claimed-key
// requests.

import type { ClientFeature } from '@kernel/rpc/contract'
import { clientUi, declareActions, declaredActions, errorMessage, subscribeDeclaredActions, type DeclaredAction } from '@kernel/interaction'
import type { ActionId, ActionSpecs } from '@kernel/interaction/contract'
import type { PanelId } from '@workspace/document/contract'
import { clientHas } from '@client/connections'

export interface ActionContext {
  /** The workspace the window shows, or null. */
  workspaceId: string | null
  /** The canvas the request came from (its context menu), when one did. */
  canvasId?: string
  /** The document window the request came from; the main window when absent. */
  windowId?: string
}

export interface ActionBinding {
  run(context: ActionContext): void | Promise<void>
  /** Hidden (and not run) on clients without these features. */
  requires?: readonly ClientFeature[]
  /** Hidden from the palette and menus, and not run, while this is false. */
  enabled?: (context: ActionContext) => boolean
}

const bindings = new Map<ActionId, ActionBinding>()
const listeners = new Set<() => void>()
let version = 0

function changed(): void {
  version++
  for (const listener of [...listeners]) listener()
}

/** Declares actions and binds each one; returns the undo. Every declared
 *  action has a binding. */
export function registerActions<S extends ActionSpecs>(specs: S, bound: { [K in keyof S]: ActionBinding }): () => void {
  const undeclare = declareActions(specs)
  const entries = Object.entries(bound) as [ActionId, ActionBinding][]
  for (const [id, binding] of entries) bindings.set(id, binding)
  changed()
  return () => {
    for (const [id, binding] of entries) if (bindings.get(id) === binding) bindings.delete(id)
    undeclare()
    changed()
  }
}

/** Bound and supported by this client, whether or not it is enabled now
 *  (what a native menu lists). */
export function actionSupported(id: ActionId): boolean {
  const binding = bindings.get(id)
  return !!binding && (binding.requires ?? []).every((feature) => clientHas(feature))
}

/** Bound, supported by this client and enabled for `context`. */
export function canRunAction(id: ActionId, context: ActionContext): boolean {
  return actionSupported(id) && (bindings.get(id)!.enabled?.(context) ?? true)
}

/** Runs an action; resolves false when it cannot run. A failure is shown to
 *  the user. */
export async function runAction(id: ActionId, context: ActionContext): Promise<boolean> {
  if (!canRunAction(id, context)) return false
  try {
    await bindings.get(id)!.run(context)
  } catch (err) {
    clientUi().showError(errorMessage(err, 'The action failed.'))
  }
  return true
}

/** Declared actions that can run for `context`, in declaration order. */
export function availableActions(context: ActionContext): DeclaredAction[] {
  return declaredActions().filter(({ id }) => canRunAction(id, context))
}

export function subscribeActions(listener: () => void): () => void {
  listeners.add(listener)
  const offDeclared = subscribeDeclaredActions(listener)
  return () => { listeners.delete(listener); offDeclared() }
}

/** Changes whenever actions are declared or bound. */
export function actionsVersion(): number {
  return version
}

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

type PanelShortcutListener = (workspaceId: string, panelId: PanelId, action: ActionId) => boolean
const panelShortcutListeners = new Set<PanelShortcutListener>()

/** Hands an action the panel's definition `claimsShortcuts` to its view (a
 *  native menu pick; keys reach the focused view directly). True when a view
 *  handled it. */
export function requestPanelShortcut(workspaceId: string, panelId: PanelId, action: ActionId): boolean {
  let handled = false
  for (const listener of [...panelShortcutListeners]) handled = listener(workspaceId, panelId, action) || handled
  return handled
}

export function onPanelShortcut(listener: PanelShortcutListener): () => void {
  panelShortcutListeners.add(listener)
  return () => { panelShortcutListeners.delete(listener) }
}
