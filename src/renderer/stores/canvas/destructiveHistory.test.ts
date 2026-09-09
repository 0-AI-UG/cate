// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ panels: {} as Record<string, any>, confirm: vi.fn() }))
vi.mock('../appStore', () => ({ useAppStore: { getState: () => ({ selectedWorkspaceId: 'ws', workspaces: [{ id: 'ws', panels: h.panels }], addPanel: (_: string, p: any) => { h.panels[p.id] = p }, closePanel: (_: string, id: string) => { delete h.panels[id] } }) } }))
vi.mock('../../lib/confirmClosePanels', () => ({ confirmClosePanels: h.confirm }))
import { createCanvasStore } from '../canvasStore'
beforeEach(() => { h.panels = { a: { id: 'a', type: 'editor', title: 'a', isDirty: false }, b: { id: 'b', type: 'editor', title: 'b', isDirty: true } }; h.confirm.mockReset().mockResolvedValue(true) })
it('cancelling any selected panel leaves the entire deletion uncommitted', async () => {
  const store = createCanvasStore()
  const a = store.getState().addNode('a', 'editor', { x: 0, y: 0 }), b = store.getState().addNode('b', 'editor', { x: 600, y: 0 })
  h.confirm.mockImplementation(async (_: string, ids: string[]) => !ids.includes('b'))
  store.getState().selectNodes([a, b]); await store.getState().deleteSelection()
  expect(h.confirm).toHaveBeenCalled()
  expect(Object.keys(h.panels)).toEqual(['a', 'b'])
  expect(store.getState().nodes[a].animationState).not.toBe('exiting')
})
it('redo rechecks newly dirty editors before changing panels or history', async () => {
  const store = createCanvasStore(), a = store.getState().addNode('a', 'editor', { x: 0, y: 0 })
  store.getState().selectNodes([a]); await store.getState().deleteSelection(); store.getState().finalizeRemoveNode(a)
  expect(h.panels.a).toBeUndefined()
  store.getState().undo(); h.panels.a.isDirty = true; h.panels.a.unsavedContent = 'new edits'
  h.confirm.mockResolvedValue(false)
  const future = store.getState().future
  await store.getState().redo()
  expect(h.panels.a?.unsavedContent).toBe('new edits')
  expect(store.getState().nodes[a]).toBeDefined()
  expect(store.getState().future).toBe(future)
})
