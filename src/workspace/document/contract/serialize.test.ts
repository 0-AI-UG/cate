import { describe, expect, it } from 'vitest'
import { rect } from '@workspace/canvas/contract'
import { applyOp } from './apply'
import type { DocChange } from './ops'
import { allStacks, canvasOf, canvasPanelOf, documentOrder, panelsInWindow, panelsOnCanvas, stacksIn, windowOf } from './selectors'
import { createDocument, type WorkspaceDocument } from './schema'
import { DOCUMENT_FILE_VERSION, parseDocument, serializeDocument, validateDocument } from './serialize'

const R = rect(0, 0, 400, 300)

function sample(): WorkspaceDocument {
  const changes: DocChange[] = [
    { kind: 'addPanel', record: { id: 'a', type: 'terminal', title: 'a', fields: { n: 1 } }, at: { to: 'stack', dock: { windowId: 'main', layoutId: 'main' }, stackId: 's1' } },
    { kind: 'addPanel', record: { id: 'cv', type: 'canvas', title: 'cv', canvasId: 'c1', fields: {} }, at: { to: 'split', dock: { windowId: 'main', layoutId: 'main' }, beside: 's1', side: 'right', stackId: 's2', splitId: 'p1' } },
    { kind: 'addPanel', record: { id: 'x', type: 'editor', title: 'x', fields: {} }, at: { to: 'canvas', canvasId: 'c1', nodeId: 'n1', stackId: 'sn1', rect: R } },
    { kind: 'addPanel', record: { id: 'w', type: 'browser', title: 'w', fields: {} }, at: { to: 'window', windowId: 'w1', layoutId: 'main', stackId: 'sw' } },
    { kind: 'addPanel', record: { id: 'cv2', type: 'canvas', title: 'cv2', canvasId: 'c2', fields: {} }, at: { to: 'stack', dock: { windowId: 'w1', layoutId: 'main' }, stackId: 'sw' } },
    { kind: 'addPanel', record: { id: 'y', type: 'chat', title: 'y', fields: {} }, at: { to: 'canvas', canvasId: 'c2', nodeId: 'n2', stackId: 'sn2', rect: R } },
    { kind: 'addRelation', relation: { id: 'r1', fromPanelId: 'a', toPanelId: 'x', kind: 'use' } },
    { kind: 'setWorktree', worktree: { id: 'wt', path: '/r', color: '#fff', status: 'ready' } },
  ]
  const result = applyOp(createDocument(), { kind: 'batch', changes })
  if (result.error) throw new Error(result.error.message)
  return result.doc
}

const file = (document: unknown) => JSON.stringify({ version: DOCUMENT_FILE_VERSION, document })

describe('document.json', () => {
  it('round trips', () => {
    const doc = sample()
    const parsed = parseDocument(serializeDocument(doc))
    expect(parsed).toEqual({ ok: true, doc })
  })

  it('rejects anything that is not a version 2 document file', () => {
    expect(parseDocument('{').ok).toBe(false)
    expect(parseDocument(JSON.stringify(sample())).ok).toBe(false)
    expect(parseDocument(JSON.stringify({ version: 3, document: sample() })).ok).toBe(false)
  })

  it('rejects documents that break an invariant', () => {
    const doc = sample()
    const broken: [string, (d: WorkspaceDocument) => unknown][] = [
      ['old panel type', (d) => ({ ...d, panels: { ...d.panels, a: { ...d.panels.a, type: 'agent' } } })],
      ['unplaced panel', (d) => ({ ...d, panels: { ...d.panels, q: { id: 'q', type: 'terminal', title: '', fields: {} } } })],
      ['placed twice', (d) => ({ ...d, windows: { ...d.windows, main: { ...d.windows.main, dock: { kind: 'stack', id: 's9', panels: ['a', 'a', 'cv'] } } } })],
      ['missing main', (d) => ({ ...d, windows: { w1: d.windows.w1 } })],
      ['detached window with a position', (d) => ({ ...d, windows: { ...d.windows, w1: { ...d.windows.w1, bounds: R } } })],
      ['one-child split', (d) => ({ ...d, windows: { ...d.windows, main: { ...d.windows.main, dock: { kind: 'split', id: 'p', direction: 'horizontal', children: [{ kind: 'stack', id: 's1', panels: ['a', 'cv'] }], ratios: [1] } } } })],
      ['canvas without panel', (d) => ({ ...d, canvases: { ...d.canvases, c9: { id: 'c9', nodes: {} } } })],
      ['canvas panel on a canvas', (d) => ({ ...d, canvases: { ...d.canvases, c1: { ...d.canvases.c1, nodes: { n1: { ...d.canvases.c1.nodes.n1, dock: { kind: 'stack', id: 'sn1', panels: ['x', 'cv2'] } } } } }, windows: { ...d.windows, w1: { ...d.windows.w1, dock: { kind: 'stack', id: 'sw', panels: ['w'] } } } })],
      ['relation to a missing panel', (d) => ({ ...d, relations: { r1: { ...d.relations.r1, toPanelId: 'nope' } } })],
      ['bad worktree status', (d) => ({ ...d, worktrees: { wt: { ...d.worktrees.wt, status: 'done' } } })],
      ['extra key', (d) => ({ ...d, activeCanvasId: 'c1' })],
    ]
    for (const [name, mutate] of broken) {
      expect(parseDocument(file(mutate(doc))).ok, name).toBe(false)
    }
    expect(validateDocument(doc)).toBeNull()
  })
})

describe('selectors', () => {
  it('list panels by window and canvas, and find where a panel shows', () => {
    const doc = sample()
    expect(panelsInWindow(doc, 'main')).toEqual(['a', 'cv', 'x'])
    expect(panelsInWindow(doc, 'w1')).toEqual(['w', 'cv2', 'y'])
    expect(panelsOnCanvas(doc, 'c1')).toEqual(['x'])
    expect(canvasOf(doc, 'x')).toBe('c1')
    expect(canvasOf(doc, 'a')).toBeNull()
    expect(canvasPanelOf(doc, 'c2')?.id).toBe('cv2')
    expect(windowOf(doc, 'y')).toBe('w1')
    expect(windowOf(doc, 'a')).toBe('main')
    expect(windowOf(doc, 'nope')).toBeNull()
  })

  it('list stacks and the document order', () => {
    const doc = sample()
    expect(stacksIn(doc, { windowId: 'main', layoutId: 'main' }).map((s) => s.id)).toEqual(['s1', 's2'])
    expect(allStacks(doc).map((s) => s.stack.id)).toEqual(['s1', 's2', 'sw', 'sn1', 'sn2'])
    expect(documentOrder(doc)).toEqual(['a', 'cv', 'w', 'cv2', 'x', 'y'])
  })
})
