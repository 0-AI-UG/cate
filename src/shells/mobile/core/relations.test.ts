import { describe, expect, it } from 'vitest'
import { panelConnectionCurve } from '@workspace/canvas/contract'
import { createDocument, type PanelRecord, type WorkspaceDocument } from '@workspace/document/contract'
import { relationsOf } from './relations'

const record = (id: string): PanelRecord => ({ id, type: 'terminal', title: id, fields: {} })
const stack = (id: string, panels: string[]) => ({ kind: 'stack' as const, id, panels })

function docWith(onCanvas: boolean): WorkspaceDocument {
  const doc = createDocument()
  return {
    ...doc,
    panels: { a: record('a'), b: record('b') },
    canvases: onCanvas
      ? {
          c: {
            id: 'c',
            nodes: {
              n1: { id: 'n1', rect: { origin: { x: 0, y: 0 }, size: { width: 400, height: 300 } }, dock: stack('s1', ['a']) },
              n2: { id: 'n2', rect: { origin: { x: 700, y: 500 }, size: { width: 400, height: 300 } }, dock: stack('s2', ['b']) },
            },
          },
        }
      : {},
    relations: { r: { id: 'r', fromPanelId: 'a', toPanelId: 'b', kind: 'use', fromSide: 'right', label: ' feeds ' } },
  } as WorkspaceDocument
}

describe('relations as the app shows them', () => {
  it('carries the curve the desktop draws, in canvas units, and its own label', () => {
    const [relation] = relationsOf(docWith(true))
    const curve = panelConnectionCurve(
      { origin: { x: 0, y: 0 }, size: { width: 400, height: 300 } },
      { origin: { x: 700, y: 500 }, size: { width: 400, height: 300 } },
      'right',
    )
    expect(relation.curve).toEqual({ canvasId: 'c', fromNodeId: 'n1', toNodeId: 'n2', ...curve })
    expect(relation.custom).toBe('feeds')
  })

  it('has no curve when its panels share no canvas', () => {
    expect(relationsOf(docWith(false))[0].curve).toBeNull()
  })
})
