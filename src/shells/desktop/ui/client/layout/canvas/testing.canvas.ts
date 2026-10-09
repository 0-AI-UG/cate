// Test helpers: an in-memory document the view stores run against, with the
// ops each test proposed recorded.

import { applyOp, createDocument, type DocBatch, type DocChange, type WorkspaceDocument } from '@workspace/document/contract'
import type { Rect } from '@workspace/canvas/contract'
import type { CanvasDocumentSource } from './store'

export interface FakeDocument extends CanvasDocumentSource {
  proposed: (DocChange | DocBatch)[]
  set(doc: WorkspaceDocument): void
}

export function fakeDocument(doc: WorkspaceDocument = createDocument()): FakeDocument {
  let current = doc
  const listeners = new Set<() => void>()
  const emit = () => { for (const l of [...listeners]) l() }
  const fake: FakeDocument = {
    proposed: [],
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    propose(change) {
      fake.proposed.push(change)
      const result = applyOp(current, change)
      if (result.error) return { ok: false }
      current = result.doc
      emit()
      return { ok: true }
    },
    set(next) {
      current = next
      emit()
    },
  }
  return fake
}

/** A document with a canvas panel in the main window and one node per
 *  entry (each holding one terminal panel). */
export function canvasDocument(nodes: { nodeId: string; panelId: string; rect: Rect }[], canvasId = 'c1'): WorkspaceDocument {
  let doc = createDocument()
  const apply = (change: DocChange) => {
    const result = applyOp(doc, change)
    if (result.error) throw new Error(result.error.message)
    doc = result.doc
  }
  apply({
    kind: 'addPanel',
    record: { id: 'canvas-panel', type: 'canvas', title: 'Canvas', canvasId, fields: {} },
    at: { to: 'stack', dock: { windowId: 'main', layoutId: 'main' }, stackId: 'main-stack' },
  })
  for (const n of nodes) {
    apply({
      kind: 'addPanel',
      record: { id: n.panelId, type: 'terminal', title: n.panelId, fields: {} },
      at: { to: 'canvas', canvasId, nodeId: n.nodeId, stackId: `stack-${n.nodeId}`, rect: n.rect },
    })
  }
  return doc
}
