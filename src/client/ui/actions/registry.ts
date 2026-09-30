// Binding shortcut actions to what they do, over client/host's action
// registry (the one path for keys, native menus and the palette). What this
// adds is what the palette and keyboard need to know about an action: the
// client features it needs, whether it can run now, and whether the palette
// lists it. Modules that own an action bind it here (the desktop shell:
// window actions; client/ui: the palette, settings, workspace switching and
// panel actions in builtin.ts, the canvas's zoom, navigation and tools in
// canvas.ts). Every shortcut action has a binding. Palette entries that are
// not shortcut actions register with `registerCommand`.

import { useSyncExternalStore } from 'react'
import type { ClientFeature } from '@kernel/rpc/contract'
import { SHORTCUT_ACTIONS, type IconName, type ShortcutAction } from '@kernel/ui/contract'
import { clientHas } from '@client/connections'
import { hasAction, registerAction as registerHostAction, runAction as runHostAction, type ActionContext } from '@client/host'
import { useUIStore } from '../state/uiStore'

export interface ActionBinding {
  run(context: ActionContext): void | Promise<void>
  /** Hidden (and not run) on clients without these features. */
  requires?: readonly ClientFeature[]
  /** Hidden from the palette and not run while this is false. */
  enabled?: () => boolean
  /** Listed in the palette (default true). */
  inPalette?: boolean
}

export type ActionMeta = Omit<ActionBinding, 'run'>

export interface PaletteCommand {
  id: string
  title: string
  icon?: IconName
  run(): void | Promise<void>
  requires?: readonly ClientFeature[]
  enabled?: () => boolean
}

const meta = new Map<string, ActionMeta>()
const commands = new Map<string, PaletteCommand>()
const listeners = new Set<() => void>()
let version = 0

const changed = (): void => {
  version++
  for (const l of [...listeners]) l()
}

const allowed = (m: { requires?: readonly ClientFeature[]; enabled?: () => boolean } | undefined): boolean =>
  !m || ((m.requires ?? []).every((f) => clientHas(f)) && (m.enabled?.() ?? true))

/** Describes an action someone else binds (a feature it needs, when it can
 *  run, whether the palette lists it). */
export function describeAction(action: string, description: ActionMeta): () => void {
  meta.set(action, description)
  changed()
  return () => {
    if (meta.get(action) !== description) return
    meta.delete(action)
    changed()
  }
}

/** Binds an action with its description; returns an unbind. */
export function bindAction(action: ShortcutAction | string, binding: ActionBinding): () => void {
  const { run, ...description } = binding
  const offHost = registerHostAction(action, run)
  const offMeta = describeAction(action, description)
  return () => { offHost(); offMeta() }
}

export function bindActions(bindings: Partial<Record<ShortcutAction, ActionBinding>>): () => void {
  const offs = Object.entries(bindings).map(([action, binding]) => bindAction(action, binding!))
  return () => { for (const off of offs) off() }
}

export function registerCommand(command: PaletteCommand): () => void {
  commands.set(command.id, command)
  changed()
  return () => {
    if (commands.get(command.id) !== command) return
    commands.delete(command.id)
    changed()
  }
}

/** Bound and available on this client right now. */
export function canRunAction(action: string): boolean {
  return hasAction(action) && allowed(meta.get(action))
}

/** Runs an action for this window's workspace; false when it is unbound or
 *  unavailable. */
export function runAction(action: string): boolean {
  if (!canRunAction(action)) return false
  void runHostAction(action, { workspaceId: useUIStore.getState().selectedWorkspaceId })
  return true
}

/** Shortcut actions the palette lists, in catalog order. */
export function paletteActions(): ShortcutAction[] {
  return SHORTCUT_ACTIONS.filter((action) => canRunAction(action) && meta.get(action)?.inPalette !== false)
}

export function paletteCommands(): PaletteCommand[] {
  return [...commands.values()].filter(allowed)
}

function subscribeActions(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Re-renders when descriptions or commands change. */
export function useActionsVersion(): number {
  return useSyncExternalStore(subscribeActions, () => version)
}
