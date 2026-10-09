// Creating panels from the client (13.5): the record is built through the
// type's definition with a client-side kit and goes to the runtime as one
// `addPanel` op with its placement. Ids are made here, so nothing is renamed
// when the runtime confirms.

import {
  createDocument,
  placementOf,
  type PanelId,
  type PanelRecord,
  type PanelType,
} from '@workspace/document/contract'
import { createPanelKit, placeTargetFor, type PanelCreateOptions, type PanelKit } from '@panels/framework/contract'
import { clientStateFor, documentStoreFor } from '@client/document'
import { panelDefinition } from './definitions'

export const newId = (): string => globalThis.crypto.randomUUID()

/** The kit a definition's `create` gets on this client. `add` proposes the op
 *  to the workspace's document mirror (applied locally at once). */
export function clientPanelKit(workspaceId: string): PanelKit {
  return createPanelKit({
    document: () => documentStoreFor(workspaceId)?.getSnapshot() ?? createDocument(),
    newId,
    definitionOf(type) {
      const definition = panelDefinition(type)
      if (!definition) throw new Error(`unknown panel type ${type}`)
      return definition
    },
    add(record, placement = {}) {
      const store = documentStoreFor(workspaceId)
      const definition = panelDefinition(record.type)
      if (!store || !definition) return null
      const at = placeTargetFor(store.getSnapshot(), definition, placement, newId)
      const result = store.propose({ kind: 'addPanel', record, at })
      return result.ok ? record.id : null
    },
  })
}

/** Creates a panel of `type` in the workspace and returns its id, or null
 *  when the type is unknown or the placement failed. A new panel inherits the
 *  worktree of `near` unless the options name one. It becomes the focused
 *  panel and the active tab of its stack. */
export function createPanel(
  workspaceId: string,
  type: PanelType | string,
  options: PanelCreateOptions & Record<string, unknown> = {},
): PanelId | null {
  const definition = panelDefinition(type)
  if (!definition) return null
  const kit = clientPanelKit(workspaceId)
  const nearRecord = options.near ? kit.document().panels[options.near] : undefined
  const worktreeId = options.worktreeId ?? nearRecord?.worktreeId
  const withWorktree = worktreeId ? { ...options, worktreeId } : options
  let id: PanelId | null
  if (definition.create) {
    id = definition.create(withWorktree, kit)
  } else {
    const record: PanelRecord = kit.record(definition.type, {
      id: newId(),
      title: options.title,
      worktreeId,
      fields: definition.fields?.(withWorktree) ?? {},
    })
    id = kit.add(record, options)
  }
  if (id) activateNewPanel(workspaceId, id)
  return id
}

function activateNewPanel(workspaceId: string, panelId: PanelId): void {
  const doc = documentStoreFor(workspaceId)?.getSnapshot()
  const state = clientStateFor(workspaceId)
  const placement = doc ? placementOf(doc, panelId) : null
  if (!state || !placement) return
  state.setActiveTab(placement.stackId, panelId)
  state.focus(panelId)
}
