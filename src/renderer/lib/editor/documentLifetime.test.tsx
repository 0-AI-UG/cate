// @vitest-environment jsdom
import React, { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFileSync, type FileSync } from './useFileSync'
import { __resetModelCacheForTest, rememberBaseline } from './modelCache'
import { registerEditorSave, unregisterEditorSave, saveEditor } from './editorSaveRegistry'
import { confirmCloseDirtyPanels } from '../confirmCloseDirty'

const state = vi.hoisted(() => ({
  panels: {} as Record<string, any>,
  extraWorkspaces: [] as Array<{ id: string; rootPath: string; panels: Record<string, any> }>,
  watchScopes: new Map<Function, { rootPath: string; workspaceId?: string }>(),
  listeners: new Set<(event: { path: string; type: string }) => void>(),
}))
vi.mock('../fs/fsWatchManager', () => ({ watchFsRoot: (rootPath: string, listener: any, workspaceId?: string) => {
  state.listeners.add(listener)
  state.watchScopes.set(listener, { rootPath, workspaceId })
  return () => { state.listeners.delete(listener); state.watchScopes.delete(listener) }
} }))
vi.mock('../../stores/appStore', () => ({ useAppStore: Object.assign(() => undefined, { getState: () => ({
  workspaces: [{ id: 'ws', rootPath: '/repo', panels: state.panels }, ...state.extraWorkspaces],
  getWorkspace: () => ({ id: 'ws', rootPath: '/repo', panels: state.panels }),
  setPanelDirty: (_: string, id: string, isDirty: boolean) => { state.panels[id].isDirty = isDirty },
  updatePanelTitle: (_: string, id: string, title: string) => { state.panels[id].title = title },
  updatePanelFilePath: (_: string, id: string, filePath: string) => { state.panels[id].filePath = filePath },
  setPanelUnsavedContent: (_: string, id: string, unsavedContent?: string) => { state.panels[id].unsavedContent = unsavedContent },
}) }) }))

const roots: Root[] = []
const syncs = new Map<string, FileSync>()
function model(initial: string) {
  let value = initial
  let disposed = false
  return { getValue: () => value, setValue: (next: string) => { value = next }, isDisposed: () => disposed, dispose: () => { disposed = true } }
}
function Harness({ id, filePath, buffer }: { id: string; filePath: string | undefined; buffer: ReturnType<typeof model> }) {
  filePath = state.panels[id]?.filePath
  const sync = useFileSync({ workspaceId: 'ws', panelId: id, filePath, rootPath: filePath?.startsWith('cate-runtime:') ? 'cate-runtime://srv/repo' : '/repo', getModel: () => buffer as any })
  syncs.set(id, sync)
  useEffect(() => { registerEditorSave(id, sync.save); return () => unregisterEditorSave(id) }, [id, sync.save])
  return null
}
function mount(id: string, filePath: string | undefined, buffer: ReturnType<typeof model>) {
  state.panels[id] ??= { id, type: 'editor', title: id, filePath, isDirty: false }
  const root = createRoot(document.createElement('div'))
  roots.push(root)
  act(() => root.render(<Harness id={id} filePath={filePath} buffer={buffer} />))
  return root
}
let api: { fsReadFile: ReturnType<typeof vi.fn>; fsWriteFile: ReturnType<typeof vi.fn>; confirmUnsavedChanges: ReturnType<typeof vi.fn>; saveFileDialog: ReturnType<typeof vi.fn> }
beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  __resetModelCacheForTest()
  state.panels = {}
  state.extraWorkspaces = []
  state.watchScopes.clear()
  api = { fsReadFile: vi.fn().mockResolvedValue('disk'), fsWriteFile: vi.fn().mockResolvedValue(undefined), confirmUnsavedChanges: vi.fn().mockResolvedValue('save'), saveFileDialog: vi.fn().mockResolvedValue('/repo/saved.ts') }
  Object.assign(window, { electronAPI: api })
})
afterEach(() => { act(() => roots.splice(0).forEach(root => root.unmount())); state.listeners.clear(); syncs.clear() })

describe('editor document lifetime', () => {
  it('saves an inactive dirty file after its view unregisters', async () => {
    const buffer = model('disk')
    const root = mount('a', '/repo/a.ts', buffer)
    act(() => syncs.get('a')!.noteLoaded('disk'))
    buffer.setValue('edited')
    act(() => syncs.get('a')!.noteUserEdit())
    act(() => root.render(null))
    expect(await saveEditor('a')).toBe('saved')
    expect(api.fsWriteFile).toHaveBeenCalledWith('/repo/a.ts', 'edited', 'ws', 'disk')
  })
  it('does not accept Save when a dirty document cannot be saved', async () => {
    expect(await confirmCloseDirtyPanels([{ id: 'missing', type: 'editor', title: 'Missing', isDirty: true }])).toBe(false)
  })
  it('clears both views after saving their shared document', async () => {
    const buffer = model('disk')
    mount('a', '/repo/a.ts', buffer)
    mount('b', '/repo/a.ts', buffer)
    act(() => { syncs.get('a')!.noteLoaded('disk'); syncs.get('b')!.noteLoaded('disk') })
    buffer.setValue('edited')
    act(() => { syncs.get('a')!.noteUserEdit(); syncs.get('b')!.noteUserEdit() })
    await act(async () => { await syncs.get('a')!.save() })
    expect(state.panels.a.isDirty).toBe(false)
    expect(state.panels.b.isDirty).toBe(false)
    expect(syncs.get('b')!.isDirtyRef.current).toBe(false)
  })
  it('restores the remote baseline before allowing a warm document to save', async () => {
    const path = 'cate-runtime://srv/repo/a.ts'
    rememberBaseline(path, 'disk')
    const buffer = model('mine')
    mount('a', path, buffer)
    api.fsReadFile.mockResolvedValue('external')
    await act(async () => { await syncs.get('a')!.resyncFromDisk() })
    expect(syncs.get('a')!.conflict?.kind).toBe('changed')
    expect(await syncs.get('a')!.save()).toBe(false)
    expect(api.fsWriteFile).not.toHaveBeenCalled()
  })
  it('subscribes remote documents through the shared filesystem watcher', () => {
    mount('a', 'cate-runtime://srv/repo/a.ts', model('disk'))
    expect(state.listeners.size).toBe(1)
  })
})

it('retains edits made during an asynchronous save and blocks close', async () => {
  const buffer = model('disk')
  mount('a', '/repo/a.ts', buffer)
  act(() => syncs.get('a')!.noteLoaded('disk'))
  buffer.setValue('first edit')
  act(() => syncs.get('a')!.noteUserEdit())
  let finish!: () => void
  api.fsWriteFile.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  let saving!: Promise<boolean>
  await act(async () => { saving = syncs.get('a')!.save(); await Promise.resolve() })
  buffer.setValue('second edit')
  act(() => syncs.get('a')!.noteUserEdit())
  await act(async () => { finish(); expect(await saving).toBe(false) })
  expect(state.panels.a.isDirty).toBe(true)
})

it('closes the watcher and forgets a dirty buffer only when its last owning panel is removed', async () => {
  const { releaseEditorPanel, captureEditorPanel } = await import('./editorDocuments')
  const buffer = model('disk')
  mount('a', '/repo/a.ts', buffer)
  mount('b', '/repo/a.ts', buffer)
  act(() => { syncs.get('a')!.noteLoaded('disk'); buffer.setValue('edited'); syncs.get('a')!.noteUserEdit() })
  act(() => releaseEditorPanel('a'))
  expect(state.listeners.size).toBe(1)
  expect(captureEditorPanel(state.panels.b).unsavedContent).toBe('edited')
  act(() => releaseEditorPanel('b'))
  expect(state.listeners.size).toBe(0)
})


it('Save As joins an already-open clean target document and updates both views', async () => {
  const target = model('disk')
  const scratch = model('replacement')
  mount('target', '/repo/saved.ts', target)
  mount('scratch', undefined, scratch)
  act(() => { syncs.get('target')!.noteLoaded('disk'); syncs.get('scratch')!.noteUserEdit() })
  await act(async () => { expect(await syncs.get('scratch')!.save()).toBe(true) })
  expect(target.getValue()).toBe('replacement')
  expect(state.panels.scratch.filePath).toBe('/repo/saved.ts')
  expect(state.panels.target.isDirty).toBe(false)
  expect(state.panels.scratch.isDirty).toBe(false)
})

it('hands the document watcher to a remaining workspace after its first owner closes', async () => {
  const { editorDocument, releaseEditorPanel } = await import('./editorDocuments')
  const path = '/repo/shared.ts'
  const first = mount('a', path, model('disk'))
  state.panels.b = { id: 'b', type: 'editor', title: 'Shared', filePath: path, isDirty: false }
  state.extraWorkspaces = [{ id: 'other', rootPath: '/repo', panels: { b: state.panels.b } }]
  const remaining = editorDocument('other', 'b', path, '/repo')
  const buffer = model('disk')
  const detach = remaining.attach({ getModel: () => buffer })
  remaining.noteLoaded('disk')
  act(() => first.render(null))
  releaseEditorPanel('a')
  api.fsReadFile.mockImplementation(async (_path: string, workspaceId: string) => {
    if (workspaceId !== 'other') throw new Error('Original workspace is closed')
    return 'external update'
  })
  try {
    await act(async () => {
      state.listeners.forEach(listener => listener({ path, type: 'update' }))
      await Promise.resolve()
    })
    expect(api.fsReadFile).toHaveBeenLastCalledWith(path, 'other')
    expect(buffer.getValue()).toBe('external update')
    expect([...state.watchScopes.values()]).toEqual([{ rootPath: '/repo', workspaceId: 'other' }])
  } finally {
    detach()
    releaseEditorPanel('b')
  }
})

it('moves every dirty document descendant without losing its buffer or recreating the old path', async () => {
  const buffer = model('disk')
  mount('moved', '/repo/folder/a.ts', buffer)
  act(() => syncs.get('moved')!.noteLoaded('disk'))
  buffer.setValue('edited')
  act(() => syncs.get('moved')!.noteUserEdit())
  const documents = await import('./editorDocuments')
  await act(async () => { (documents as any).applyFileEntryMove({ from: '/repo/folder', to: '/repo/renamed' }) })
  expect(state.panels.moved.filePath).toBe('/repo/renamed/a.ts')
  expect(await saveEditor('moved')).toBe('saved')
  expect(api.fsWriteFile).toHaveBeenCalledWith('/repo/renamed/a.ts', 'edited', 'ws', 'disk')
  expect(api.fsWriteFile.mock.calls.some(([path]) => path === '/repo/folder/a.ts')).toBe(false)
})

it('preserves an overwritten destination document as unsaved recovery while moving the source', async () => {
  const source = model('disk'), destination = model('disk')
  mount('source-move', '/repo/source.ts', source)
  mount('target-move', '/repo/target.ts', destination)
  act(() => { syncs.get('source-move')!.noteLoaded('disk'); syncs.get('target-move')!.noteLoaded('disk') })
  source.setValue('source edits'); destination.setValue('destination edits')
  act(() => { syncs.get('source-move')!.noteUserEdit(); syncs.get('target-move')!.noteUserEdit() })
  const documents = await import('./editorDocuments')
  await act(async () => { (documents as any).applyFileEntryMove({ from: '/repo/source.ts', to: '/repo/target.ts' }) })
  expect(state.panels['source-move'].filePath).toBe('/repo/target.ts')
  expect(state.panels['target-move'].filePath).toBeUndefined()
  expect(documents.captureEditorPanel(state.panels['target-move']).unsavedContent).toBe('destination edits')
  expect(documents.captureEditorPanel(state.panels['source-move']).unsavedContent).toBe('source edits')
})

it('updates a clean destination view to the moved source buffer', async () => {
  const source = model('disk'), destination = model('old destination')
  mount('source-clean-target', '/repo/source.ts', source)
  mount('clean-target', '/repo/target.ts', destination)
  act(() => { syncs.get('source-clean-target')!.noteLoaded('disk'); syncs.get('clean-target')!.noteLoaded('old destination') })
  source.setValue('source edits')
  act(() => syncs.get('source-clean-target')!.noteUserEdit())
  const documents = await import('./editorDocuments')
  await act(async () => { documents.applyFileEntryMove({ from: '/repo/source.ts', to: '/repo/target.ts' }) })
  expect(destination.getValue()).toBe('source edits')
  expect(documents.captureEditorPanel(state.panels['clean-target']).unsavedContent).toBe('source edits')
})

it('retires warm models of moved files even after their last panel closed', async () => {
  const cache = await import('./modelCache')
  const warm = model('old disk')
  cache.rememberModel('/repo/closed.ts', warm)
  const documents = await import('./editorDocuments')
  documents.applyFileEntryMove({ from: '/repo/closed.ts', to: '/repo/renamed.ts' })
  expect(cache.getCachedModel('/repo/closed.ts')).toBeUndefined()
  expect(warm.isDisposed()).toBe(true)
})

it('does not save to an obsolete path when relocation occurs during the pre-save read', async () => {
  const buffer = model('disk'); mount('save-moving', '/repo/a.ts', buffer)
  act(() => syncs.get('save-moving')!.noteLoaded('disk'))
  buffer.setValue('edits'); act(() => syncs.get('save-moving')!.noteUserEdit())
  let finish!: (value: string) => void
  api.fsReadFile.mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve }))
  const save = syncs.get('save-moving')!.save()
  const documents = await import('./editorDocuments')
  await act(async () => { documents.applyFileEntryMove({ from: '/repo/a.ts', to: '/repo/b.ts' }); finish('disk'); await save })
  expect(api.fsWriteFile.mock.calls.some(([path]) => path === '/repo/a.ts')).toBe(false)
  expect(documents.editorDocument('ws', 'save-moving', '/repo/b.ts').filePathRef.current).toBe('/repo/b.ts')
  expect(documents.captureEditorPanel(state.panels['save-moving']).isDirty).toBe(true)
})
