// Every panel type's actions, from its definition: `panel.new.<type>` for a
// creatable type (File > New, its default key, the palette) and
// `panel.<type>.<command>` for each command (sent to the focused panel of
// the type; listed in the palette while one is focused, and under the type in
// the menu bar's Panel menu when the command asks).

import { tryRuntimeFor } from '@kernel/rpc/client'
import { isIconName, type ActionId, type ActionSpecs } from '@kernel/ui/contract'
import { documentStoreFor } from '@client/document'
import { registerActions, type ActionBinding, type ActionContext } from './actions'
import { panelDefinitions } from './definitions'
import { focusedLeafPanelId } from './focus'

export const newPanelActionId = (type: string): ActionId => `panel.new.${type}`
export const panelCommandActionId = (type: string, command: string): ActionId => `panel.${type}.${command}`

/** The focused panel of the context's workspace when it is of `type`. */
function focusedOfType(context: ActionContext, type: string): string | null {
  const { workspaceId } = context
  const panelId = workspaceId ? focusedLeafPanelId(workspaceId) : null
  const record = workspaceId && panelId ? documentStoreFor(workspaceId)?.getSnapshot().panels[panelId] : undefined
  return record?.type === type ? record.id : null
}

/** Declares and binds the panel actions of every registered definition;
 *  `create` runs a `panel.new.<type>` (the caller decides where the panel
 *  goes). Returns the undo. */
export function registerPanelActions(create: (type: string, context: ActionContext) => void | Promise<void>): () => void {
  const specs: ActionSpecs = {}
  const bound: Record<ActionId, ActionBinding> = {}
  for (const definition of panelDefinitions()) {
    const { type, creation } = definition
    if (creation) {
      const id = newPanelActionId(type)
      specs[id] = {
        title: creation.title ?? `New ${definition.label}`,
        ...(creation.key ? { key: creation.key } : {}),
        ...(isIconName(definition.icon) ? { icon: definition.icon } : {}),
        welcome: true,
        menu: { bar: 'file', group: 'new', order: creation.order },
      }
      bound[id] = { run: (context) => create(type, context), requires: definition.requires }
    }
    for (const command of definition.commands ?? []) {
      const id = panelCommandActionId(type, command.id)
      specs[id] = {
        title: command.title,
        ...(command.keyHint ? { keyHint: command.keyHint } : {}),
        ...(isIconName(definition.icon) ? { icon: definition.icon } : {}),
        ...(command.menu ? { menu: { bar: 'panel', group: type, submenu: definition.label } } : {}),
      }
      bound[id] = {
        requires: [...definition.requires, ...(command.requires ?? [])],
        enabled: (context) => !!focusedOfType(context, type),
        async run(context) {
          const panelId = focusedOfType(context, type)
          if (panelId && context.workspaceId) await tryRuntimeFor(context.workspaceId)?.session.op({ panelId, op: command.op })
        },
      }
    }
  }
  return registerActions(specs, bound)
}
