import { beforeEach, expect, it, vi } from 'vitest'
import { MAIN_WINDOW, applyOp, createDocument, type DocChange, type WorkspaceDocument } from '@workspace/document/contract'

const h = vi.hoisted(() => ({
  doc: null as unknown as WorkspaceDocument,
  focused: null as string | null,
  op: vi.fn(async (_call: { panelId: string; op: unknown }): Promise<unknown> => true),
  focus: vi.fn(),
}))
vi.mock('@client/document', () => ({
  documentStoreFor: () => ({
    getSnapshot: () => h.doc,
    propose: (change: DocChange) => {
      const result = applyOp(h.doc, change)
      if (result.error) return { ok: false, refused: result.error }
      h.doc = result.doc
      return { ok: true }
    },
  }),
  clientStateFor: () => ({ getSnapshot: () => ({ focusedPanelId: h.focused }), focus: h.focus, setActiveTab: () => {} }),
}))
vi.mock('@kernel/rpc/client', () => ({ runtimeFor: () => ({ session: { op: h.op } }) }))

import { openAgentChanges, openReviewPanel } from './openReview'

const at = { to: 'stack' as const, dock: { windowId: MAIN_WINDOW }, stackId: 's1' }
const add = (id: string, type: 'review' | 'terminal', fields = {}) => {
  h.doc = applyOp(h.doc, { kind: 'addPanel', record: { id, type, title: id, fields }, at }).doc
}

beforeEach(() => {
  h.doc = createDocument()
  h.focused = null
  h.op.mockClear()
  h.focus.mockClear()
})

it('retargets the focused review of the checkout instead of adding one', async () => {
  add('r1', 'review', { repoPath: '/repo' })
  add('r2', 'review', { repoPath: '/repo' })
  h.focused = 'r1'
  expect(await openReviewPanel({ workspaceId: 'ws', repoPath: '/repo', spec: { kind: 'staged' }, focusedFile: 'a.ts' })).toBe('r1')
  expect(h.op).toHaveBeenCalledWith({ panelId: 'r1', op: { kind: 'retarget', request: { spec: { kind: 'staged' }, focusedFile: 'a.ts' } } })
  expect(Object.keys(h.doc.panels)).toEqual(['r1', 'r2'])
})

it('adds a review next to the source agent when the checkout has none', async () => {
  add('term', 'terminal')
  const id = await openReviewPanel({ workspaceId: 'ws', repoPath: '/repo', spec: { kind: 'uncommitted' }, sourceAgent: { runId: 'run', ownerPanelId: 'owner', panelId: 'term' } })
  expect(id).toBeTruthy()
  expect(h.doc.panels[id!]).toMatchObject({ type: 'review', fields: { repoPath: '/repo', request: { spec: { kind: 'uncommitted' } } } })
  expect(h.focus).toHaveBeenCalledWith(id)
  expect(h.op).not.toHaveBeenCalled()
})

it('opens agent changes in a new panel, or moves a chosen review to the agent checkout', async () => {
  add('term', 'terminal')
  expect(await openAgentChanges({ workspaceId: 'ws', panelId: 'term', cwd: '/wt', turnId: 't' })).toBe(true)
  const created = Object.values(h.doc.panels).find((panel) => panel.type === 'review')!
  expect(created).toMatchObject({ title: 'Agent changes', fields: { repoPath: '/wt', request: { agentChanges: { panelId: 'term', turnId: 't' } } } })

  add('r1', 'review', { repoPath: '/repo' })
  expect(await openAgentChanges({ workspaceId: 'ws', panelId: 'term', cwd: '/wt', reviewPanelId: 'r1' })).toBe(true)
  expect(h.op).toHaveBeenNthCalledWith(1, { panelId: 'r1', op: { kind: 'switchCheckout', path: '/wt' } })
  expect(h.op).toHaveBeenNthCalledWith(2, { panelId: 'r1', op: { kind: 'retarget', request: expect.objectContaining({ agentChanges: { panelId: 'term' } }) } })
  expect(await openAgentChanges({ workspaceId: 'ws', panelId: 'gone', cwd: '/wt' })).toBe(false)
})
