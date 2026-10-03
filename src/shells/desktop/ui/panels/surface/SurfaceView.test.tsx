import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MAIN_WINDOW, applyOp, createDocument, type PanelRecord, type WorkspaceDocument } from '@workspace/document/contract'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const h = vi.hoisted(() => ({ doc: null as unknown as WorkspaceDocument, propose: vi.fn((_change: unknown) => ({ ok: true })) }))
vi.mock('@client/document', () => ({ documentStoreFor: () => ({ getSnapshot: () => h.doc, propose: h.propose }) }))
vi.mock('../../client/document', () => ({ useDocument: (_ws: string, select: (doc: WorkspaceDocument) => unknown) => select(h.doc) }))
vi.mock('@client/connections', () => ({ clientHas: () => true }))

import SurfaceView from './SurfaceView'
import { pickSurface } from './parts/pickSurface'

const surface: PanelRecord = { id: 'p1', type: 'surface', title: 'Open a surface', worktreeId: 'wt', fields: {} }
let host: HTMLDivElement
let root: Root

beforeEach(() => {
  h.propose.mockClear()
  h.doc = applyOp(createDocument(), { kind: 'addPanel', record: surface, at: { to: 'stack', dock: { windowId: MAIN_WINDOW }, stackId: 's1' } }).doc
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

it('replaces the surface with the picked type under the same id', () => {
  act(() => root.render(<SurfaceView workspaceId="ws" panelId="p1" record={surface} session={null as never} send={async () => undefined} snapshot={null} visible focused={false} />))
  const buttons = [...host.querySelectorAll('button')]
  expect(buttons.map((b) => b.textContent)).not.toContain('Open a surface')
  act(() => buttons.find((b) => b.textContent === 'Diff Review')!.click())
  expect(h.propose).toHaveBeenCalledTimes(1)
  const change = h.propose.mock.calls[0][0] as { kind: string; record: PanelRecord }
  expect(change).toEqual({ kind: 'replacePanel', record: { id: 'p1', type: 'review', title: 'Diff Review', worktreeId: 'wt', fields: { repoPath: '' } } })
  // The runtime applies it as a replacement: same id and placement, new type.
  const next = applyOp(h.doc, change as never)
  expect(next.error).toBeUndefined()
  expect(next.doc.panels.p1.type).toBe('review')
})

it('does not turn a surface into a surface or into an unknown type', () => {
  const store = { getSnapshot: () => h.doc, propose: h.propose } as never
  expect(pickSurface(store, surface, 'surface')).toBe(false)
  expect(pickSurface(store, surface, 'nope' as never)).toBe(false)
  expect(h.propose).not.toHaveBeenCalled()
})
