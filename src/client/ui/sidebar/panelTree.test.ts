import { describe, expect, it } from 'vitest'
import { applyOp, createDocument, MAIN_WINDOW, type DocChange, type PanelRecord, type WorkspaceDocument } from '@workspace/document/contract'
import { sortByWorktree, workspacePanelTree } from './panelTree'
import { moveId } from './WorkspaceList'
import { connectionLabel, relativeTime } from './connectionStatus'

const rec = (id: string, type: string, extra: Partial<PanelRecord> = {}): PanelRecord => ({ id, type, title: id, fields: {}, ...extra } as PanelRecord)
const main = { windowId: MAIN_WINDOW }
const rect = { origin: { x: 0, y: 0 }, size: { width: 100, height: 100 } }

function build(changes: DocChange[]): WorkspaceDocument {
  let doc = createDocument()
  for (const change of changes) {
    const result = applyOp(doc, change)
    if (result.error) throw new Error(result.error.message)
    doc = result.doc
  }
  return doc
}

describe('workspacePanelTree', () => {
  const doc = build([
    { kind: 'addPanel', record: rec('c1', 'canvas', { canvasId: 'cv1' }), at: { to: 'stack', dock: main, stackId: 's1' } },
    { kind: 'addPanel', record: rec('t1', 'terminal'), at: { to: 'canvas', canvasId: 'cv1', nodeId: 'n1', stackId: 'ns1', rect } },
    { kind: 'addPanel', record: rec('e1', 'editor'), at: { to: 'canvas', canvasId: 'cv1', nodeId: 'n2', stackId: 'ns2', rect } },
    { kind: 'addPanel', record: rec('b1', 'browser'), at: { to: 'stack', dock: main, stackId: 's1' } },
    { kind: 'addPanel', record: rec('c2', 'canvas', { canvasId: 'cv2' }), at: { to: 'window', windowId: 'w2', stackId: 's2', bounds: rect } },
    { kind: 'addPanel', record: rec('t2', 'terminal'), at: { to: 'canvas', canvasId: 'cv2', nodeId: 'n3', stackId: 'ns3', rect } },
  ])

  it('nests canvas panels and lists the rest of the window top-level', () => {
    const tree = workspacePanelTree(doc)
    expect(tree.primary.canvases.map((c) => [c.record.id, c.children.map((p) => p.id)])).toEqual([['c1', ['t1', 'e1']]])
    expect(tree.primary.topLevel.map((p) => p.id)).toEqual(['b1'])
  })

  it('lists other windows after this one and counts every row', () => {
    const tree = workspacePanelTree(doc)
    expect(tree.others.map((w) => [w.windowId, w.canvases[0].record.id, w.canvases[0].children.map((p) => p.id)])).toEqual([['w2', 'c2', ['t2']]])
    expect(tree.count).toBe(6)
  })

  it('puts the rendering window first in a detached window', () => {
    const tree = workspacePanelTree(doc, { windowId: 'w2' })
    expect(tree.primary.windowId).toBe('w2')
    expect(tree.others.map((w) => w.windowId)).toEqual([MAIN_WINDOW])
  })
})

describe('sortByWorktree', () => {
  const worktrees = [
    { id: 'wt-feature', path: '/repo-feature' },
    { id: 'wt-main', path: '/repo' },
  ]
  it('keeps untagged and primary panels first, then other worktrees, else document order', () => {
    const panels = [
      { id: 'a', worktreeId: 'wt-feature' },
      { id: 'b' },
      { id: 'c', worktreeId: 'unknown' },
      { id: 'd', worktreeId: 'wt-main' },
      { id: 'e', worktreeId: 'wt-feature' },
    ]
    expect(sortByWorktree(panels, worktrees, '/repo').map((p) => p.id)).toEqual(['b', 'd', 'a', 'e', 'c'])
  })
})

describe('moveId', () => {
  it('moves to an insertion slot', () => {
    expect(moveId(['a', 'b', 'c'], 0, 3)).toEqual(['b', 'c', 'a'])
    expect(moveId(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
    expect(moveId(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c'])
  })
})

describe('connection labels', () => {
  it('describe offline with the last-seen time', () => {
    const now = 10 * 60_000
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 minutes ago')
    expect(connectionLabel({ kind: 'offline', lastSeen: now - 2 * 3_600_000, retrying: true }, now)).toBe('Offline, last seen 2 hours ago. Retrying.')
    expect(connectionLabel({ kind: 'offline', lastSeen: null, retrying: false, error: 'ECONNREFUSED' })).toBe('Not reachable: ECONNREFUSED')
  })

  it('name an incompatible runtime and stay quiet when connected', () => {
    expect(connectionLabel({ kind: 'incompatible', runtimeVersion: '1.9.0' })).toContain('1.9.0')
    expect(connectionLabel({ kind: 'connected' })).toBeNull()
  })
})
