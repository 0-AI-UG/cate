// The `filesTreeOnOpen` client setting: when a workspace's document first
// loads on this client and no tree-only Files panel is docked, dock one at
// the chosen side of the main window, a fifth of its width.

import { documentStoreFor, documentWorkspaceIds, subscribeDocumentStores, type DocumentStore } from '@client/document'
import { activeLayoutId, createPanel, newId } from '@client/host'
import { getClientSetting } from '../../kernel/settings'
import { MAIN_WINDOW, dockOf, isCanvasDock, parentOf, placementOf, type WorkspaceDocument } from '@workspace/document/contract'

const TREE_RATIO = 0.2

const hasDockedTree = (doc: WorkspaceDocument): boolean =>
  Object.values(doc.panels).some((panel) => {
    if (panel.type !== 'editor' || panel.fields.treeOnly !== true) return false
    const placement = placementOf(doc, panel.id)
    return !!placement && !isCanvasDock(placement.dock)
  })

/** Docks a tree-only Files panel in the main window unless one is docked. */
export function ensureFilesTree(workspaceId: string, side: 'left' | 'right'): string | null {
  const store = documentStoreFor(workspaceId)
  if (!store) return null
  const before = store.getSnapshot()
  if (hasDockedTree(before)) return null
  const dock = { windowId: MAIN_WINDOW, layoutId: activeLayoutId(workspaceId, MAIN_WINDOW) }
  const root = dockOf(before, dock) ?? null
  const stackId = newId()
  const id = createPanel(workspaceId, 'editor', {
    title: 'Files',
    treeOnly: true,
    at: root
      ? { to: 'split', dock, beside: root.id, side, stackId, splitId: newId() }
      : { to: 'stack', dock, stackId },
  })
  if (!id || !root) return id
  // A split gives equal shares; the tree takes a narrow column and the rest
  // keep their proportions.
  const after = store.getSnapshot()
  const placed = placementOf(after, id)
  const split = placed && parentOf(dockOf(after, dock), placed.stackId)?.parent
  if (!split) return id
  const previous = new Map<string, number>()
  if (root.kind === 'split') root.children.forEach((child, i) => previous.set(child.id, root.ratios[i]))
  const others = split.children.length - 1
  const ratios = split.children.map((child) =>
    child.id === placed.stackId ? TREE_RATIO : (previous.get(child.id) ?? 1 / others) * (1 - TREE_RATIO))
  store.propose({ kind: 'setSplitRatio', splitId: split.id, ratios })
  return id
}

/** Runs the setting for each workspace as its document first loads. */
export function startFilesTreeOnOpen(): () => void {
  const seen = new WeakSet<DocumentStore>()
  let stopped = false
  const sync = () => {
    for (const workspaceId of documentWorkspaceIds()) {
      const store = documentStoreFor(workspaceId)
      if (!store || seen.has(store)) continue
      seen.add(store)
      void store.ready.then(() => {
        const side = getClientSetting('filesTreeOnOpen')
        if (stopped || side === 'off' || documentStoreFor(workspaceId) !== store) return
        ensureFilesTree(workspaceId, side)
      })
    }
  }
  const stop = subscribeDocumentStores(sync)
  sync()
  return () => { stopped = true; stop() }
}
