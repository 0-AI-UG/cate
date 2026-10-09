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
  type WorkspaceDocument,
} from '@workspace/document/contract'
import { placeTargetFor, type PanelCreateOptions, type PanelKit } from '@panels/framework/contract'
import { clientStateFor, documentStoreFor } from '@client/document'
import { panelDefinition } from './definitions'
import { withActiveLayout } from './layouts'

export const newId = (): string => globalThis.crypto.randomUUID()

/** The kit a definition's `create` gets on this client. `add` proposes the op
 *  to the workspace's document mirror (applied locally at once). */
export function clientPanelKit(workspaceId: string): PanelKit {
  const doc = (): WorkspaceDocument => documentStoreFor(workspaceId)?.getSnapshot() ?? createDocument()
  const kit: PanelKit = {
    newId,
    record(type, init) {
      const definition = panelDefinition(type)
      return {
        id: init.id,
        type,
        title: init.title ?? definition?.defaultTitle ?? type,
        ...(init.worktreeId ? { worktreeId: init.worktreeId } : {}),
        ...(init.canvasId ? { canvasId: init.canvasId } : {}),
        fields: init.fields ?? {},
      }
    },
    add(record, placement = {}) {
      const store = documentStoreFor(workspaceId)
      const definition = panelDefinition(record.type)
      if (!store || !definition) return null
      const at = placeTargetFor(store.getSnapshot(), definition, withActiveLayout(workspaceId, placement), newId)
      const result = store.propose({ kind: 'addPanel', record, at })
      return result.ok ? record.id : null
    },
    document: doc,
    numberedTitle(type, base) {
      const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(\\d+)$`)
      let max = 0
      for (const panel of Object.values(doc().panels)) {
        if (panel.type !== type) continue
        const match = re.exec(panel.title)
        if (match) max = Math.max(max, Number(match[1]))
      }
      return `${base} ${max + 1}`
    },
    uniqueTitle(title, panelId) {
      const taken = new Set(Object.values(doc().panels).filter((p) => p.id !== panelId).map((p) => p.title))
      if (!taken.has(title)) return title
      for (let n = 2; ; n++) if (!taken.has(`${title} ${n}`)) return `${title} ${n}`
    },
    worktreeIdForPath(path) {
      if (!path) return undefined
      let best: { id: string; length: number } | undefined
      for (const worktree of Object.values(doc().worktrees)) {
        const root = worktree.path.replace(/[/\\]+$/, '')
        const inside = path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`)
        if (inside && (!best || root.length > best.length)) best = { id: worktree.id, length: root.length }
      }
      return best?.id
    },
  }
  return kit
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
