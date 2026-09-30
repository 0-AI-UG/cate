// document.json: the persisted document. Parsing is strict: a malformed file
// or any other format is rejected, never repaired or migrated.

import { dockPanels, visitDock, type DockNode } from './dock'
import { MAIN_WINDOW, type WorkspaceDocument } from './schema'
import { checkDock, checkRecord, checkRelation, checkWorktree, isId, isObject, isRect } from './validate'

export const DOCUMENT_FILE_VERSION = 1

export interface DocumentFile {
  version: typeof DOCUMENT_FILE_VERSION
  document: WorkspaceDocument
}

export function serializeDocument(doc: WorkspaceDocument): string {
  const file: DocumentFile = { version: DOCUMENT_FILE_VERSION, document: doc }
  return `${JSON.stringify(file, null, 2)}\n`
}

export type ParseResult = { ok: true; doc: WorkspaceDocument } | { ok: false; error: string }

/** Parse and validate document.json text. */
export function parseDocument(text: string): ParseResult {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { ok: false, error: `not JSON: ${(error as Error).message}` }
  }
  if (!isObject(value) || value.version !== DOCUMENT_FILE_VERSION) return { ok: false, error: 'not a version 1 document file' }
  const error = validateDocument(value.document)
  return error ? { ok: false, error } : { ok: true, doc: value.document as WorkspaceDocument }
}

/** Every invariant applyOp keeps. Null when `value` is a valid document. */
export function validateDocument(value: unknown): string | null {
  if (!isObject(value)) return 'document is not an object'
  const keys = ['panels', 'windows', 'canvases', 'relations', 'worktrees']
  if (Object.keys(value).length !== keys.length || !keys.every((key) => isObject(value[key]))) {
    return 'document must have exactly panels, windows, canvases, relations and worktrees'
  }
  const doc = value as unknown as WorkspaceDocument

  for (const [id, record] of Object.entries(doc.panels)) {
    const problem = checkRecord(record)
    if (problem) return `panel ${id}: ${problem}`
    if (record.id !== id) return `panel ${id} is filed under the wrong key`
  }

  const placed = new Set<string>()
  const nodeIds = new Set<string>()
  const place = (tree: DockNode | null, where: string, onCanvas: boolean): string | null => {
    if (tree === null) return null
    const problem = checkDock(tree)
    if (problem) return `${where}: ${problem}`
    let error: string | null = null
    visitDock(tree, (node) => {
      if (nodeIds.has(node.id)) error = `dock node id ${node.id} is used twice`
      nodeIds.add(node.id)
      return error !== null
    })
    if (error) return error
    for (const panelId of dockPanels(tree)) {
      const record = doc.panels[panelId]
      if (!record) return `${where}: panel ${panelId} does not exist`
      if (placed.has(panelId)) return `panel ${panelId} is placed twice`
      if (onCanvas && record.type === 'canvas') return `canvas panel ${panelId} is on a canvas`
      placed.add(panelId)
    }
    return null
  }

  const main = doc.windows[MAIN_WINDOW]
  if (!isObject(main) || main.kind !== 'main') return 'the main window is missing'
  for (const [id, window] of Object.entries(doc.windows)) {
    if (!isObject(window) || window.id !== id) return `window ${id} is malformed`
    if (window.kind === 'main') {
      if (id !== MAIN_WINDOW || window.bounds !== undefined) return `window ${id} is not the main window`
    } else if (window.kind !== 'detached' || window.dock === null || !isRect(window.bounds)) {
      return `detached window ${id} needs a dock and bounds`
    }
    if (Object.keys(window).some((key) => !['id', 'kind', 'dock', 'bounds'].includes(key))) return `window ${id} has unknown keys`
    const problem = place(window.dock, `window ${id}`, false)
    if (problem) return problem
  }

  const canvasPanels = new Map<string, string>()
  for (const record of Object.values(doc.panels)) {
    if (record.type !== 'canvas') continue
    if (canvasPanels.has(record.canvasId!)) return `canvas ${record.canvasId} has two panels`
    canvasPanels.set(record.canvasId!, record.id)
  }
  const seenNodes = new Set<string>()
  for (const [id, canvas] of Object.entries(doc.canvases)) {
    if (!isObject(canvas) || canvas.id !== id || !isObject(canvas.nodes)) return `canvas ${id} is malformed`
    if (!canvasPanels.has(id)) return `canvas ${id} has no canvas panel`
    for (const [nodeId, node] of Object.entries(canvas.nodes)) {
      if (!isObject(node) || node.id !== nodeId || !isRect(node.rect) || !node.dock) return `node ${nodeId} is malformed`
      if (seenNodes.has(nodeId)) return `node id ${nodeId} is used twice`
      seenNodes.add(nodeId)
      const problem = place(node.dock, `node ${nodeId}`, true)
      if (problem) return problem
    }
  }
  for (const canvasId of canvasPanels.keys()) {
    if (!doc.canvases[canvasId]) return `canvas ${canvasId} is missing`
  }
  for (const id of Object.keys(doc.panels)) {
    if (!placed.has(id)) return `panel ${id} is not placed`
  }

  const pairs = new Set<string>()
  for (const [id, relation] of Object.entries(doc.relations)) {
    const problem = checkRelation(relation)
    if (problem) return `relation ${id}: ${problem}`
    if (relation.id !== id) return `relation ${id} is filed under the wrong key`
    if (!doc.panels[relation.fromPanelId] || !doc.panels[relation.toPanelId]) return `relation ${id} names a missing panel`
    if (relation.fromPanelId === relation.toPanelId) return `relation ${id} relates a panel to itself`
    const pair = `${relation.fromPanelId}\n${relation.toPanelId}`
    if (pairs.has(pair)) return `relation ${id} repeats a pair`
    pairs.add(pair)
  }
  for (const [id, worktree] of Object.entries(doc.worktrees)) {
    const problem = checkWorktree(worktree)
    if (problem) return `worktree ${id}: ${problem}`
    if (worktree.id !== id || !isId(id)) return `worktree ${id} is filed under the wrong key`
  }
  return null
}
