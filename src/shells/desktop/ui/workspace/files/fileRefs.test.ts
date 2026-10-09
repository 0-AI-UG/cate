// File refs end to end: the resolver and the explorer's tree model over real
// files runtimes, each served over its own rpc connection. Two runtimes stand
// for two workspaces (either may be on another machine: bytes only travel
// through the capabilities); two connections to one runtime stand for two
// clients of the same workspace.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { installMockClientUi } from '@kernel/interaction/testing'
import { createFileRefs, createWatchManager, type FsClient } from '@workspace/files/client'
import type { FileEntry, FileRef } from '@workspace/files/contract'
import { FileTreeModel } from '@workspace/files/client'
import { droppedImport, resolveFileDrop } from './droppedEntries'
import { makeWorkspace, until } from '@workspace/files/testing.test-helpers'

type Workspace = Awaited<ReturnType<typeof makeWorkspace>>
type Connection = Awaited<ReturnType<Workspace['connect']>>

let a: Workspace
let b: Workspace
const models: FileTreeModel[] = []

beforeEach(async () => {
  installMockClientUi()
  a = await makeWorkspace()
  b = await makeWorkspace()
})
afterEach(async () => {
  for (const model of models.splice(0)) model.dispose()
  await a.dispose()
  await b.dispose()
})

/** One client: its connections by workspace id, its resolver, and trees. */
function client(connections: Record<string, Connection>) {
  const fsOf = (id: string): FsClient => {
    const connection = connections[id]
    if (!connection) throw new Error(`not connected to ${id}`)
    return connection.fs
  }
  const refs = createFileRefs(fsOf)
  const watches = createWatchManager((id) => connections[id]?.file ?? null)
  const tree = (workspaceId: string, root: string) => {
    const model = new FileTreeModel(root, workspaceId, { fs: () => fsOf(workspaceId), refs, watch: (id, r, l) => watches.watch(id, r, l) })
    models.push(model)
    model.activate()
    return model
  }
  return { refs, tree }
}

const names = (entries: FileEntry[]) => entries.map((e) => e.name)
const rootNames = (model: FileTreeModel) => names(model.getSnapshot().nodes)
const ref = (workspaceId: string, p: string): FileRef => ({ workspaceId, path: p })

async function loaded(model: FileTreeModel): Promise<void> {
  await until(() => !model.getSnapshot().isLoading)
}

describe('explorer tree', () => {
  it('loads the root of a workspace', async () => {
    await fs.writeFile(path.join(a.root, 'readme.md'), 'hi')
    const tree = client({ a: await a.connect() }).tree('a', a.root)
    await loaded(tree)
    expect(tree.getSnapshot().loadError).toBeNull()
    expect(rootNames(tree)).toEqual(['readme.md'])
  })

  it('uploads OS files dropped by one client; another client sees them through its watch', async () => {
    const first = client({ a: await a.connect('first') }).tree('a', a.root)
    const second = client({ a: await a.connect('second') }).tree('a', a.root)
    await loaded(first)
    await loaded(second)

    const bytes = new Uint8Array(300 * 1024).map((_, i) => i % 199)
    const dropped = [{ file: new File(['note'], 'note.txt') }, { file: new File([bytes], 'blob.bin') }]
    expect(await first.importDropped(droppedImport(dropped), a.root)).toBe(true)
    expect(await fs.readFile(path.join(a.root, 'note.txt'), 'utf8')).toBe('note')
    expect(new Uint8Array(await fs.readFile(path.join(a.root, 'blob.bin')))).toEqual(bytes)

    a.watcher.fire(path.join(a.root, 'note.txt'), 'create')
    await until(() => rootNames(second).includes('note.txt') && rootNames(second).includes('blob.bin'))
  })

  it('never overwrites: a drop of an existing name gets a free one', async () => {
    const tree = client({ a: await a.connect() }).tree('a', a.root)
    await fs.writeFile(path.join(a.root, 'note.txt'), 'old')
    expect(await tree.importDropped(droppedImport([{ file: new File(['new'], 'note.txt') }]), a.root)).toBe(true)
    expect(await fs.readFile(path.join(a.root, 'note.txt'), 'utf8')).toBe('old')
    expect(await fs.readFile(path.join(a.root, 'note (2).txt'), 'utf8')).toBe('new')
  })
})

describe('moving and copying within a workspace', () => {
  beforeEach(async () => {
    await fs.mkdir(path.join(a.root, 'src', 'lib'), { recursive: true })
    await fs.mkdir(path.join(a.root, 'dest'))
    await fs.writeFile(path.join(a.root, 'src', 'a.ts'), 'a')
  })

  it('moves dropped files into the folder', async () => {
    const tree = client({ a: await a.connect() }).tree('a', a.root)
    expect(await tree.transfer([ref('a', path.join(a.root, 'src', 'a.ts'))], path.join(a.root, 'dest'), 'move')).toBe(true)
    expect(await fs.readdir(path.join(a.root, 'dest'))).toEqual(['a.ts'])
    expect(await fs.readdir(path.join(a.root, 'src'))).toEqual(['lib'])
  })

  it('skips a move onto itself or of a folder into its own subtree', async () => {
    const tree = client({ a: await a.connect() }).tree('a', a.root)
    const srcDir = path.join(a.root, 'src')
    expect(await tree.transfer([ref('a', path.join(srcDir, 'a.ts'))], srcDir, 'move')).toBe(false)
    expect(await tree.transfer([ref('a', srcDir)], path.join(srcDir, 'lib'), 'move')).toBe(false)
    expect(await tree.transfer([ref('a', srcDir)], srcDir, 'move')).toBe(false)
    expect((await fs.readdir(srcDir)).sort()).toEqual(['a.ts', 'lib'])
  })

  it('pastes a copy next to the original with a free name', async () => {
    const tree = client({ a: await a.connect() }).tree('a', a.root)
    const srcDir = path.join(a.root, 'src')
    expect(await tree.transfer([ref('a', path.join(srcDir, 'a.ts'))], srcDir, 'copy')).toBe(true)
    expect((await fs.readdir(srcDir)).sort()).toEqual(['a copy.ts', 'a.ts', 'lib'])
  })

  it('a move by one client shows up in another client of the same workspace', async () => {
    const mover = client({ a: await a.connect('mover') }).tree('a', a.root)
    const watcher = client({ a: await a.connect('watcher') }).tree('a', a.root)
    const dest = path.join(a.root, 'dest')
    await loaded(watcher)
    await watcher.ensureChildrenLoaded(dest)
    expect(watcher.getSnapshot().childrenCache.get(dest)).toEqual([])

    await mover.transfer([ref('a', path.join(a.root, 'src', 'a.ts'))], dest, 'move')
    a.watcher.fire(path.join(dest, 'a.ts'), 'create')
    await until(() => names(watcher.getSnapshot().childrenCache.get(dest) ?? []).includes('a.ts'))
  })
})

describe('refs of another workspace', () => {
  it('are copied into an explorer folder, never moved: folders, empty folders and large binaries', async () => {
    const bytes = new Uint8Array(600 * 1024).map((_, i) => i % 251)
    await fs.mkdir(path.join(a.root, 'pkg', 'nested'), { recursive: true })
    await fs.mkdir(path.join(a.root, 'pkg', 'empty'))
    await fs.writeFile(path.join(a.root, 'pkg', 'nested', 'x.txt'), 'x')
    await fs.writeFile(path.join(a.root, 'image.bin'), bytes)

    const tree = client({ a: await a.connect(), b: await b.connect() }).tree('b', b.root)
    await loaded(tree)
    expect(await tree.transfer([ref('a', path.join(a.root, 'pkg')), ref('a', path.join(a.root, 'image.bin'))], b.root, 'move')).toBe(true)

    expect(await fs.readFile(path.join(b.root, 'pkg', 'nested', 'x.txt'), 'utf8')).toBe('x')
    expect((await fs.stat(path.join(b.root, 'pkg', 'empty'))).isDirectory()).toBe(true)
    expect(new Uint8Array(await fs.readFile(path.join(b.root, 'image.bin')))).toEqual(bytes)
    expect(await fs.readFile(path.join(a.root, 'pkg', 'nested', 'x.txt'), 'utf8')).toBe('x')
    expect((await fs.stat(path.join(a.root, 'image.bin'))).size).toBe(bytes.length)
  })

  it('localize into the target root\'s .cate/tmp, with the .cate gitignore; own refs stay as they are', async () => {
    await fs.writeFile(path.join(a.root, 'a.ts'), 'from a')
    await fs.writeFile(path.join(b.root, 'own.ts'), 'own')
    const { refs } = client({ a: await a.connect(), b: await b.connect() })
    const paths = await refs.localize([ref('b', path.join(b.root, 'own.ts')), ref('a', path.join(a.root, 'a.ts'))], { workspaceId: 'b' })
    expect(paths).toEqual([path.join(b.root, 'own.ts'), path.join(b.root, '.cate', 'tmp', 'a.ts')])
    expect(await fs.readFile(paths[1], 'utf8')).toBe('from a')
    expect(await fs.readFile(path.join(b.root, '.cate', '.gitignore'), 'utf8')).toContain('*')
  })

  it('localize near a path of a worktree checkout into that checkout\'s .cate/tmp', async () => {
    const checkout = path.join(b.root, '.cate', 'worktrees', 'feature')
    await fs.mkdir(path.join(checkout, 'src'), { recursive: true })
    b.files.paths.addCheckout(checkout)
    await fs.writeFile(path.join(a.root, 'a.ts'), 'from a')
    const { refs } = client({ a: await a.connect(), b: await b.connect() })
    const [copy] = await refs.localize([ref('a', path.join(a.root, 'a.ts'))], { workspaceId: 'b', near: path.join(checkout, 'src') })
    expect(copy).toBe(path.join(checkout, '.cate', 'tmp', 'a.ts'))
  })

  it('gives two refs with the same name their own copies', async () => {
    await fs.mkdir(path.join(a.root, 'one'))
    await fs.mkdir(path.join(a.root, 'two'))
    await fs.writeFile(path.join(a.root, 'one', 'x.ts'), '1')
    await fs.writeFile(path.join(a.root, 'two', 'x.ts'), '2')
    const { refs } = client({ a: await a.connect(), b: await b.connect() })
    const paths = await refs.localize([ref('a', path.join(a.root, 'one', 'x.ts')), ref('a', path.join(a.root, 'two', 'x.ts'))], { workspaceId: 'b' })
    expect(await Promise.all(paths.map((p) => fs.readFile(p, 'utf8')))).toEqual(['1', '2'])
    expect(new Set(paths).size).toBe(2)
  })

  it('a dropped search line follows its file into the copy', async () => {
    await fs.writeFile(path.join(a.root, 'a.ts'), 'x\ny\n')
    const { refs } = client({ a: await a.connect(), b: await b.connect() })
    const source = path.join(a.root, 'a.ts')
    const result = await resolveFileDrop({ refs: [ref('a', source)], location: { path: source, line: 2, column: 1 }, os: [] }, { workspaceId: 'b' }, refs)
    expect(result).toEqual({ paths: [path.join(b.root, '.cate', 'tmp', 'a.ts')], location: { path: path.join(b.root, '.cate', 'tmp', 'a.ts'), line: 2, column: 1 } })
  })

  it('fail when the source workspace is not reachable, leaving nothing behind', async () => {
    const { refs } = client({ b: await b.connect() })
    await expect(refs.localize([ref('a', path.join(a.root, 'x'))], { workspaceId: 'b' })).rejects.toThrow()
    expect(await fs.readdir(b.root)).toEqual([])
  })
})

describe('files from the OS', () => {
  it('go to the temporary folder when the drop names no folder', async () => {
    const { refs } = client({ a: await a.connect() })
    const created = await refs.upload([{ path: 'shot.png', kind: 'file', size: 3, bytes: new Uint8Array([1, 2, 3]) }], { workspaceId: 'a' })
    expect(created).toEqual([path.join(a.root, '.cate', 'tmp', 'shot.png')])
  })
})
