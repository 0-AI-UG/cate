import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { createDocument, type WorkspaceDocument } from '@workspace/document/contract'
import { createCanvasView } from './store'
import { CanvasViewProvider } from './context'

const h = vi.hoisted(() => ({
  panels: {
    editor: { id: 'editor', type: 'editor', title: 'Files', fields: {} },
    review: { id: 'review', type: 'review', title: 'Review', fields: {} },
  },
}))
vi.mock('../../document', () => ({
  useDocument: (_ws: string, select: (doc: unknown) => unknown) => select({ panels: h.panels }),
  useClientState: (_ws: string, select: (state: unknown) => unknown) => select({ activeTabs: {} }),
}))
vi.mock('./worktree', () => ({ useWorktreeMembership: () => ({ groups: [], colorById: {} }) }))

import Minimap from './Minimap'

function documentWithNodes(): WorkspaceDocument {
  const doc = createDocument()
  const node = (id: string, x: number, panel: string) => ({
    id,
    rect: { origin: { x, y: 0 }, size: { width: 600, height: 400 } },
    dock: { kind: 'stack' as const, id: `stack-${id}`, panels: [panel] },
  })
  doc.canvases.c = { id: 'c', nodes: { one: node('one', 0, 'editor'), two: node('two', 700, 'review') } }
  return doc
}

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
it('colours each node by its active panel type', () => {
  const doc = documentWithNodes()
  const store = createCanvasView({
    workspaceId: 'ws',
    canvasId: 'c',
    animate: false,
    document: { getSnapshot: () => doc, subscribe: () => () => {}, propose: () => ({ ok: true }) },
  })
  act(() => store.getState().setContainerSize({ width: 1000, height: 800 }))
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    act(() => root.render(<CanvasViewProvider store={store}><Minimap workspaceId="ws" /></CanvasViewProvider>))
    const colors = [...host.querySelectorAll<HTMLElement>('[style]')].map(element => element.style.backgroundColor)
    for (const type of ['editor', 'review']) {
      expect(colors).toContain(`var(--panel-${type}, var(--surface-4))`)
    }
  } finally {
    act(() => root.unmount())
    store.getState().dispose()
  }
})
