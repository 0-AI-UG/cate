// Temporary 2.0.x reader. Delete this folder and its startup call after 2.1.0.
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { checkRelation } from '@workspace/document/contract/validate'
import {
  createDocument, validateDocument, isPanelType, type DockNode, type PanelRecord, type PanelRelation,
  type WorkspaceDocument, type JsonObject,
} from '@workspace/document/contract'

export const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
export const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
const text = (v: unknown, fallback = '') => typeof v === 'string' ? v : fallback

export interface Recovery { panel: string; file: string; content: string; baseline?: string }

export function convertLayout(root: string, workspace: Record<string, unknown>, session: Record<string, unknown>) {
  const doc = createDocument()
  const sessions: Record<string, unknown> = {}
  const recovery: Recovery[] = []
  const warnings: string[] = []
  const placed = new Set<string>()
  const worktrees = Array.isArray(session.worktrees) ? session.worktrees : []
  for (const value of worktrees) {
    const w = object(value)
    if (typeof w.id !== 'string' || typeof w.path !== 'string') continue
    doc.worktrees[w.id] = { id: w.id, path: w.path, color: text(w.color, '#888888'), status: 'ready', ...(typeof w.label === 'string' ? { label: w.label } : {}) }
  }

  function panels(refs: unknown, local: unknown) {
    const saved = object(local)
    for (const [id, value] of Object.entries(object(refs))) {
      if (!/^[\w-]+$/.test(id)) throw new Error('Unsafe legacy panel id')
      const ref = object(value)
      const state = object(saved[id])
      // T3 and old comparison panels have no compatible session implementation.
      if (!isPanelType(ref.type) || ref.type === 'surface' || ref.type === 'review') {
        warnings.push(`Panel ${id} (${text(ref.type)}) is retained only in the original files`)
        continue
      }
      const fields: JsonObject = {}
      const record: PanelRecord = { id, type: ref.type, title: text(ref.title, ref.type), fields }
      if (typeof state.worktreeId === 'string' && doc.worktrees[state.worktreeId]) record.worktreeId = state.worktreeId
      const checkout = record.worktreeId ? doc.worktrees[record.worktreeId].path : root
      if (ref.titleUserOverridden === true) fields.titleUserOverridden = true
      if (ref.type === 'canvas') {
        record.canvasId = id
        doc.canvases[id] = { id, nodes: {} }
      } else if (ref.type === 'terminal') {
        const cwd = text(state.workingDirectory, text(ref.cwd, checkout))
        fields.cwd = cwd
        sessions[id] = { cwd }
      } else if (ref.type === 'editor') {
        const file = typeof ref.filePath === 'string' && ref.filePath ? path.resolve(checkout, ref.filePath) : path.join(checkout, '.cate', 'tmp', `${randomUUID()}.md`)
        fields.filePath = file
        if (ref.sidebarVisible === true && !ref.filePath) fields.treeOnly = true
        sessions[id] = { filePath: file }
        if (typeof state.unsavedContent === 'string') recovery.push({ panel: id, file, content: state.unsavedContent, ...(typeof state.editorBaseline === 'string' ? { baseline: state.editorBaseline } : {}) })
      } else if (ref.type === 'browser') {
        const tabs = (Array.isArray(ref.tabs) ? ref.tabs : []).map((tab, i) => {
          const t = object(tab)
          return { id: text(t.id, `t${i + 1}`), url: text(t.url, 'cate://newtab'), title: text(t.title), favicon: typeof t.favicon === 'string' ? t.favicon : null, pinned: t.pinned === true }
        })
        if (tabs.length) sessions[id] = { tabs, activeTabId: tabs.some(t => t.id === ref.activeTabId) ? ref.activeTabId : tabs[0].id, viewport: { preset: 'compact' } }
      }
      doc.panels[id] = record
    }
  }

  function split(direction: 'horizontal' | 'vertical', trees: DockNode[], weights: number[] = []): DockNode | null {
    if (!trees.length) return null
    if (trees.length === 1) return trees[0]
    // The new document forbids adjacent splits with the same direction.
    const children: DockNode[] = []
    const ratios: number[] = []
    trees.forEach((tree, i) => {
      const weight = weights[i] > 0 && Number.isFinite(weights[i]) ? weights[i] : 1
      if (tree.kind === 'split' && tree.direction === direction) {
        children.push(...tree.children)
        ratios.push(...tree.ratios.map(r => r * weight))
      } else { children.push(tree); ratios.push(weight) }
    })
    const total = ratios.reduce((a, b) => a + b, 0)
    return { kind: 'split', id: randomUUID(), direction, children, ratios: ratios.map(r => r / total) }
  }
  function tree(value: unknown, onCanvas = false, depth = 0): DockNode | null {
    if (depth > 32) throw new Error('Legacy dock is too deeply nested')
    const t = object(value)
    if (t.type === 'tabs') {
      const ids = strings(t.panelIds).filter(id => doc.panels[id] && !placed.has(id) && !(onCanvas && doc.panels[id].type === 'canvas'))
      ids.forEach(id => placed.add(id))
      return ids.length ? { kind: 'stack', id: randomUUID(), panels: [...new Set(ids)] } : null
    }
    if (t.type !== 'split') return null
    const children: DockNode[] = []
    const weights: number[] = []
    ;(Array.isArray(t.children) ? t.children : []).forEach((child, i) => {
      const converted = tree(child, onCanvas, depth + 1)
      if (converted) { children.push(converted); weights.push(Number((Array.isArray(t.ratios) ? t.ratios : [])[i]) || 1) }
    })
    return split(t.direction === 'vertical' ? 'vertical' : 'horizontal', children, weights)
  }
  function dock(value: unknown): DockNode | null {
    const zones = object(object(value).zones)
    const zone = (name: string) => tree(object(zones[name]).layout)
    const row = split('horizontal', [zone('left'), zone('center'), zone('right')].filter((t): t is DockNode => !!t))
    return split('vertical', [row, zone('bottom')].filter((t): t is DockNode => !!t))
  }
  function canvases(input: unknown, detached = false) {
    for (const [id, value] of Object.entries(object(input))) {
      const canvas = doc.canvases[id]
      if (!canvas) continue
      for (const [nodeId, nodeValue] of Object.entries(object(object(value)[detached ? 'nodes' : 'canvasNodes']))) {
        const node = object(nodeValue)
        const dock = tree(node.dockLayout, true)
        if (dock) canvas.nodes[nodeId] = { id: nodeId, rect: { origin: object(node.origin) as unknown as { x: number; y: number }, size: object(node.size) as unknown as { width: number; height: number } }, dock }
      }
    }
  }
  panels(workspace.panels, session.panels)
  doc.windows.main.dock = dock(workspace.dockState)
  canvases(workspace.canvases)
  for (const value of Array.isArray(session.dockWindows) ? session.dockWindows : []) {
    const window = object(value)
    const local = Object.fromEntries(Object.entries(object(window.panels)).map(([id, p]) => [id, { ...object(p), workingDirectory: object(window.terminalCwds)[id] ?? object(p).cwd }]))
    panels(window.panels, local)
    const layout = dock(window.dockState)
    if (layout) { const id = randomUUID(); doc.windows[id] = { id, kind: 'detached', dock: layout } }
    canvases(window.canvasStates, true)
  }
  // Recover orphan records in a tab stack rather than silently hiding them.
  const orphaned = Object.keys(doc.panels).filter(id => !placed.has(id))
  if (orphaned.length) doc.windows.main.dock = split('horizontal', [doc.windows.main.dock, { kind: 'stack', id: randomUUID(), panels: orphaned }].filter((t): t is DockNode => !!t))
  for (const value of Array.isArray(session.panelRelations) ? session.panelRelations : []) {
    const relation = object(value)
    if (checkRelation(relation) === null && doc.panels[String(relation.fromPanelId)] && doc.panels[String(relation.toPanelId)]) {
      doc.relations[String(relation.id)] = relation as unknown as PanelRelation
    }
  }
  const error = validateDocument(doc)
  if (error) throw new Error(`Cannot import layout: ${error}`)
  return { document: doc as WorkspaceDocument, sessions, recovery, warnings }
}
