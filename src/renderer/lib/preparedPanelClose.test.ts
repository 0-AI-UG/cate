// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({
  panel: { id: 'editor', type: 'editor', title: 'file.txt', filePath: '/worktree/file.txt', isDirty: false } as Record<string, unknown>,
  close: vi.fn(), content: 'unchanged bytes',
}))
vi.mock('../stores/appStore', () => ({ useAppStore: { getState: () => ({ workspaces: [{ id: 'workspace', panels: { editor: h.panel } }], closePanel: h.close }) } }))
vi.mock('./confirmClosePanels', () => ({ confirmClosePanels: vi.fn(async () => true) }))
vi.mock('./editor/editorDocuments', () => ({ captureEditorPanel: (panel: unknown) => panel, editorPanelContent: () => h.content }))
import { runPreparedPanelClose } from './preparedPanelClose'
afterEach(() => { vi.useRealTimers(); h.close.mockClear() })
it('does not mistake the approved backing-file deletion for a new user edit', async () => {
  vi.useFakeTimers()
  expect(await runPreparedPanelClose('workspace', 'editor', { phase: 'prepare', token: 'backing-delete' })).toBe(true)
  // The filesystem watcher preserves the unchanged buffer after Git removes
  // its backing file. This is derived recovery state, not additional typing.
  h.panel = { ...h.panel, isDirty: true, title: 'file.txt •', unsavedContent: 'unchanged bytes', editorBaseline: 'unchanged bytes' }
  expect(await runPreparedPanelClose('workspace', 'editor', { phase: 'commit', token: 'backing-delete' })).toBe(true)
  expect(h.close).toHaveBeenCalledWith('workspace', 'editor')
})

it('retains an editor when the user types after preparation', async () => {
  vi.useFakeTimers()
  expect(await runPreparedPanelClose('workspace', 'editor', { phase: 'prepare', token: 'new-edit' })).toBe(true)
  h.content = 'new user edit'
  h.panel = { ...h.panel, unsavedContent: h.content }
  expect(await runPreparedPanelClose('workspace', 'editor', { phase: 'commit', token: 'new-edit' })).toBe(false)
  expect(h.close).not.toHaveBeenCalled()
})
