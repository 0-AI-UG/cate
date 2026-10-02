import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isRpcError } from '@kernel/rpc/contract'
import { MAIN_WINDOW, type PanelRecord } from '@workspace/document/contract'
import { createDocumentService, type DocumentService } from '@workspace/document/runtime'
import { createPanelRegistry, createSessionHost, type SessionHost } from '@panels/framework/runtime'
import { makeWorkspace, until } from '@workspace/files/testing.test-helpers'
import { EditorSession, editorPanel, editorServiceHandlers, movedPath } from './runtime'

type Workspace = Awaited<ReturnType<typeof makeWorkspace>>

let ws: Workspace
let document: DocumentService
let host: SessionHost
let ids = 0

beforeEach(async () => {
  ws = await makeWorkspace()
  document = createDocumentService({ file: path.join(ws.data, 'document.json'), debounceMs: 60_000 })
  const registry = createPanelRegistry([editorPanel({
    root: ws.root,
    buffers: ws.files.buffers,
    onMoved: (listener) => ws.files.onMoved(listener),
    autosaveMs: 5,
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  })])
  host = createSessionHost({
    document,
    registry,
    surfaces: { request: async () => { throw new Error('no surface') } },
    sessionFile: (panelId) => path.join(ws.data, 'sessions', `${panelId}.json`),
    persistDebounceMs: 5,
  })
})

afterEach(async () => {
  host.dispose()
  document.dispose()
  await ws.dispose()
})

async function addEditor(id: string, filePath?: string): Promise<EditorSession> {
  const record: PanelRecord = { id, type: 'editor', title: id, fields: filePath ? { filePath } : {} }
  document.apply({ kind: 'addPanel', record, at: { to: 'stack', dock: { windowId: MAIN_WINDOW }, stackId: 's1' } })
  await host.started(id)
  return host.session(id) as EditorSession
}

const op = (id: string, value: unknown) => host.op(id, value, { clientId: null, connectionId: null })
const bufferOf = async (file: string) => {
  const handle = await ws.files.buffers.open(file)
  handle.close()
  return handle
}
function edit(file: string, text: string): Promise<void> {
  return ws.files.buffers.open(file).then((handle) => {
    handle.doc.transact(() => {
      handle.text.delete(0, handle.text.length)
      handle.text.insert(0, text)
    })
    handle.close()
  })
}
const read = (file: string) => fs.readFile(file, 'utf8')

describe('EditorSession', () => {
  it('binds its file and shares one buffer between two sessions', async () => {
    const file = path.join(ws.root, 'a.ts')
    await fs.writeFile(file, 'one')
    const a = await addEditor('a', file)
    const b = await addEditor('b', file)
    expect(a.snapshot()).toMatchObject({ filePath: file, loading: false, dirty: false, mode: 'code', documentType: null })
    await edit(file, 'two')
    expect(a.snapshot().dirty).toBe(true)
    expect(b.snapshot().dirty).toBe(true)
    expect(ws.files.buffers.openPaths()).toEqual([file])
    await op('b', { kind: 'save' })
    expect(await read(file)).toBe('two')
    expect(a.snapshot().dirty).toBe(false)
  })

  it('opens markdown in preview and previews images without a buffer', async () => {
    const md = path.join(ws.root, 'README.md')
    const png = path.join(ws.root, 'logo.png')
    await fs.writeFile(md, '# hi')
    await fs.writeFile(png, 'png')
    expect((await addEditor('md', md)).snapshot().mode).toBe('preview')
    const image = await addEditor('png', png)
    expect(image.snapshot()).toMatchObject({ documentType: 'image', mode: 'preview', loading: false })
    expect(ws.files.buffers.openPaths()).toEqual([md])
    await expect(op('png', { kind: 'setMode', mode: 'code' })).rejects.toSatisfy((e) => isRpcError(e, 'rejected'))
  })

  it('fails a save over an external change with conflict, then merges', async () => {
    const file = path.join(ws.root, 'c.txt')
    await fs.writeFile(file, 'a\nb\nc\n')
    const session = await addEditor('c', file)
    await edit(file, 'A\nb\nc\n')
    await fs.writeFile(file, 'a\nb\nC\n')
    await expect(op('c', { kind: 'save' })).rejects.toSatisfy((e) => isRpcError(e, 'conflict'))
    expect(session.snapshot().conflict).toBe('changed')
    await op('c', { kind: 'setMode', mode: 'merge' })
    expect(session.snapshot().mode).toBe('merge')
    await op('c', { kind: 'resolveConflict', resolution: 'merge' })
    expect(session.snapshot()).toMatchObject({ conflict: null, mode: 'code', dirty: true })
    await op('c', { kind: 'save' })
    expect(await read(file)).toBe('A\nb\nC\n')
  })

  it('refuses to close with unsaved edits unless discarded', async () => {
    const file = path.join(ws.root, 'd.txt')
    await fs.writeFile(file, 'disk')
    await addEditor('d', file)
    await edit(file, 'mine')
    await expect(op('d', { kind: 'close' })).rejects.toSatisfy((e) => isRpcError(e, 'dirty'))
    await expect(host.prepareClose(['d'], { discard: false })).rejects.toSatisfy((e) => isRpcError(e, 'dirty'))
    await op('d', { kind: 'close', discard: true })
    expect(document.get().panels.d).toBeUndefined()
    await until(() => ws.files.buffers.openPaths().length === 0)
    expect(await read(file)).toBe('disk')
  })

  it('readies a client-side removal: dirty until the view answers discard', async () => {
    const file = path.join(ws.root, 'g.txt')
    await fs.writeFile(file, 'disk')
    await addEditor('g', file)
    await edit(file, 'mine')
    await expect(op('g', { kind: 'prepareClose' })).rejects.toSatisfy((e) => isRpcError(e, 'dirty'))
    await op('g', { kind: 'prepareClose', discard: true })
    document.apply({ kind: 'removePanels', ids: ['g'] })
    await until(() => ws.files.buffers.openPaths().length === 0)
    expect(await read(file)).toBe('disk')
  })

  it('lets a panel close when another editor still shows the dirty buffer', async () => {
    const file = path.join(ws.root, 'e.txt')
    await fs.writeFile(file, 'disk')
    await addEditor('e1', file)
    const other = await addEditor('e2', file)
    await edit(file, 'mine')
    await op('e1', { kind: 'close' })
    expect(other.snapshot().dirty).toBe(true)
  })

  it('switches files only when clean or discarded', async () => {
    const first = path.join(ws.root, 'f1.txt')
    const second = path.join(ws.root, 'f2.txt')
    await fs.writeFile(first, '1')
    await fs.writeFile(second, '2')
    const session = await addEditor('f', first)
    await edit(first, 'changed')
    await expect(op('f', { kind: 'openFile', path: second })).rejects.toSatisfy((e) => isRpcError(e, 'dirty'))
    await op('f', { kind: 'openFile', path: second, line: 3, discard: true })
    expect(session.snapshot()).toMatchObject({ filePath: second, dirty: false, reveal: { line: 3, column: null } })
    expect(document.get().panels.f).toMatchObject({ title: 'f2.txt', fields: { filePath: second } })
    await until(() => ws.files.buffers.openPaths().length === 1)
    expect(await read(first)).toBe('1')
  })

  it('saves as a new file and follows it', async () => {
    const file = path.join(ws.root, 'g.txt')
    const target = path.join(ws.root, 'sub', 'h.txt')
    await fs.writeFile(file, 'old')
    await fs.mkdir(path.dirname(target))
    const session = await addEditor('g', file)
    await edit(file, 'new text')
    await op('g', { kind: 'saveAs', path: target })
    expect(await read(target)).toBe('new text')
    expect(await read(file)).toBe('old')
    expect(session.snapshot()).toMatchObject({ filePath: target, dirty: false })
    expect(document.get().panels.g).toMatchObject({ title: 'h.txt', fields: { filePath: target } })
    await until(() => ws.files.buffers.openPaths().length === 1)
  })

  it('follows a renamed file, carrying unsaved edits', async () => {
    const file = path.join(ws.root, 'dir', 'r.txt')
    await fs.mkdir(path.dirname(file))
    await fs.writeFile(file, 'disk')
    const a = await addEditor('ra', file)
    const b = await addEditor('rb', file)
    await edit(file, 'unsaved')
    await ws.files.rename(path.join(ws.root, 'dir'), path.join(ws.root, 'moved'))
    const target = path.join(ws.root, 'moved', 'r.txt')
    await until(() => a.snapshot().filePath === target && b.snapshot().filePath === target)
    expect(a.snapshot().dirty).toBe(true)
    expect((await bufferOf(target)).text.toString()).toBe('unsaved')
    expect(document.get().panels.ra.fields.filePath).toBe(target)
    await until(() => ws.files.buffers.openPaths().length === 1)
    await op('ra', { kind: 'save' })
    expect(await read(target)).toBe('unsaved')
  })

  it('gives an untitled editor a draft that is written once shared', async () => {
    const session = await addEditor('u')
    const draft = session.snapshot().filePath!
    expect(draft).toBe(path.join(ws.root, '.cate', 'tmp', '00000000-0000-4000-8000-000000000001.md'))
    expect(session.snapshot()).toMatchObject({ draft: true, checkout: ws.root })
    expect(document.get().panels.u).toMatchObject({ title: 'u', fields: { filePath: draft } })
    expect(session.snapshot().mode).toBe('code')
    await expect(fs.stat(draft)).rejects.toThrow()
    expect(ws.watcher.roots()).not.toContain(path.dirname(draft))

    session.setShared(true)
    expect(session.snapshot().connectedDraft).toEqual({ syncError: null })
    await until(async () => (await read(draft).catch(() => null)) === '')
    await edit(draft, 'notes for the agent')
    await until(async () => (await read(draft)) === 'notes for the agent')
    // The drafts folder did not exist when the buffer opened (a real watcher
    // fails on a missing folder); the save that created it starts the watch,
    // so the agent's plain write reaches the buffer.
    const drafts = path.dirname(draft)
    await until(() => ws.watcher.roots().includes(drafts))
    await fs.writeFile(draft, 'the agent wrote this')
    ws.watcher.fire(draft, 'update')
    await until(async () => (await bufferOf(draft)).text.toString() === 'the agent wrote this')
    expect(await read(path.join(ws.root, '.cate', '.gitignore'))).toBeTruthy()

    session.setShared(false)
    expect(session.snapshot().connectedDraft).toBeNull()

    // Saved to a real path, it is a draft no more.
    const saved = path.join(ws.root, 'notes.md')
    await op('u', { kind: 'saveAs', path: saved })
    expect(session.snapshot()).toMatchObject({ filePath: saved, draft: false })
  })

  it('flushShared reports a conflict as false', async () => {
    const file = path.join(ws.root, 'k.txt')
    await fs.writeFile(file, 'base')
    const session = await addEditor('k', file)
    await edit(file, 'mine')
    await fs.writeFile(file, 'theirs')
    expect(await session.flushShared()).toBe(false)
    expect(session.snapshot().conflict).toBe('changed')
  })

  it('persists the mode for its file', async () => {
    const file = path.join(ws.root, 'notes.md')
    await fs.writeFile(file, '# x')
    await addEditor('m', file)
    await op('m', { kind: 'setMode', mode: 'code' })
    await until(async () => !!(await fs.stat(path.join(ws.data, 'sessions', 'm.json')).catch(() => null)))
    host.dispose()
    const again = createSessionHost({
      document,
      registry: createPanelRegistry([editorPanel({ root: ws.root, buffers: ws.files.buffers })]),
      surfaces: { request: async () => null },
      sessionFile: (panelId) => path.join(ws.data, 'sessions', `${panelId}.json`),
    })
    await again.restore()
    expect((again.session('m') as EditorSession).snapshot().mode).toBe('code')
    again.dispose()
  })

  it('answers cate.editor.active', async () => {
    const file = path.join(ws.root, 'z.txt')
    await fs.writeFile(file, 'z')
    const session = await addEditor('z', file)
    const result = await session.handleApi!('active', {}, {} as never)
    expect(result).toEqual({ panelId: 'z', filePath: file, dirty: false })
  })
})

describe('cate.editor.openFile', () => {
  it('reuses an editor showing the file and reveals the line', async () => {
    const file = path.join(ws.root, 'o.ts')
    await fs.writeFile(file, 'x')
    const session = await addEditor('o', file)
    const created: string[] = []
    const handlers = editorServiceHandlers({
      root: ws.root,
      document,
      paths: ws.files.paths,
      stat: (p) => ws.files.stat(p),
      createPanel: () => { created.push('new'); return null },
      started: (id) => host.started(id),
      session: (id) => host.session(id),
    })
    const ctx = { caller: { kind: 'cli', id: 'c' } } as never
    expect(await handlers.openFile({ path: 'o.ts', line: 7 }, ctx)).toEqual({ panelId: 'o' })
    expect(session.snapshot().reveal).toEqual({ seq: 1, line: 7, column: null })
    expect(created).toEqual([])
    await expect(handlers.openFile({ path: 'missing.ts' }, ctx)).rejects.toSatisfy((e) => isRpcError(e, 'rejected'))
    await expect(handlers.openFile({ path: '.' }, ctx)).rejects.toSatisfy((e) => isRpcError(e, 'rejected'))
  })
})

describe('movedPath', () => {
  it('maps a file and files below a moved directory', () => {
    expect(movedPath('/a/b.txt', '/a/b.txt', '/c.txt')).toBe('/c.txt')
    expect(movedPath('/a/b/c.txt', '/a/b', '/x')).toBe('/x/c.txt')
    expect(movedPath('/a/bc.txt', '/a/b', '/x')).toBeUndefined()
  })
})
