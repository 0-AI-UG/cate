// Open buffers: shared Yjs documents per file, saved against their base hash,
// persisted while dirty, reconciled with external changes.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'
import { isRpcError } from '@kernel/rpc/contract'
import { BUFFER_TEXT, contentHash } from './contract'
import { createFilesRuntime } from './runtime'
import { attachBuffer } from './client'
import { makeWorkspace, until } from './testing.test-helpers'

let ws: Awaited<ReturnType<typeof makeWorkspace>>
let file: string
beforeEach(async () => {
  ws = await makeWorkspace()
  file = path.join(ws.root, 'notes.md')
  await fs.writeFile(file, 'line one\nline two\n')
})
afterEach(async () => { await ws.dispose() })

const bufferFiles = async () => (await fs.readdir(path.join(ws.data, 'buffers')).catch(() => [])).filter((n) => n.endsWith('.bin'))

describe('open buffers', () => {
  it('loads on first open and shares one document between handles', async () => {
    const a = await ws.files.buffers.open(file)
    const b = await ws.files.buffers.open(file)
    expect(a.doc).toBe(b.doc)
    expect(a.text.toString()).toBe('line one\nline two\n')
    expect(a.state()).toEqual({ path: file, baseHash: contentHash('line one\nline two\n'), dirty: false, conflict: null })
    a.text.insert(0, '# ')
    expect(b.state().dirty).toBe(true)
    a.close()
    b.close()
  })

  it('two remote subscribers converge', async () => {
    const one = await ws.connect()
    const two = await ws.connect()
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const a = attachBuffer(one.file, file, docA)
    const b = attachBuffer(two.file, file, docB)
    await Promise.all([a.ready, b.ready])
    expect(docA.getText(BUFFER_TEXT).toString()).toBe('line one\nline two\n')

    // Concurrent edits on both sides.
    docA.getText(BUFFER_TEXT).insert(0, 'A ')
    docB.getText(BUFFER_TEXT).insert(docB.getText(BUFFER_TEXT).length, 'B\n')
    await until(() => docA.getText(BUFFER_TEXT).toString() === docB.getText(BUFFER_TEXT).toString()
      && docA.getText(BUFFER_TEXT).toString().includes('B\n') && docB.getText(BUFFER_TEXT).toString().startsWith('A '))
    const handle = await ws.files.buffers.open(file)
    expect(handle.text.toString()).toBe('A line one\nline two\nB\n')
    await until(() => a.state()?.dirty === true && b.state()?.dirty === true)

    const saved = await b.save()
    expect(saved.dirty).toBe(false)
    expect(await fs.readFile(file, 'utf8')).toBe('A line one\nline two\nB\n')
    await until(() => a.state()?.dirty === false)
    handle.close()
    a.close()
    b.close()
  })

  it('a client edit made before attaching is sent after the sync handshake', async () => {
    const one = await ws.connect()
    const docA = new Y.Doc()
    const a = attachBuffer(one.file, file, docA)
    await a.ready
    const handle = await ws.files.buffers.open(file)
    docA.getText(BUFFER_TEXT).insert(0, 'x')
    await until(() => handle.text.toString().startsWith('x'))
    handle.close()
    a.close()
  })

  it('keeps a UTF-8 byte order mark through open and save', async () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello\n')])
    await fs.writeFile(file, bytes)
    const handle = await ws.files.buffers.open(file)
    expect(handle.text.toString()).toBe('hello\n')
    await handle.save()
    expect(Buffer.compare(await fs.readFile(file), bytes)).toBe(0)
    handle.close()
  })

  it('opens a file that is not UTF-8 read-only and refuses to save it', async () => {
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]) // "café" in Latin-1
    await fs.writeFile(file, latin1)
    const handle = await ws.files.buffers.open(file)
    expect(handle.state().readOnly).toBe(true)
    const err = await handle.save().catch((e: unknown) => e)
    expect(isRpcError(err, 'rejected')).toBe(true)
    expect(Buffer.compare(await fs.readFile(file), latin1)).toBe(0)
    handle.close()
  })

  it('save fails with conflict when the disk moved since load', async () => {
    const handle = await ws.files.buffers.open(file)
    handle.text.insert(0, 'mine ')
    await fs.writeFile(file, 'theirs\n')
    const err = await handle.save().catch((e) => e)
    expect(isRpcError(err, 'conflict')).toBe(true)
    expect(err.data).toEqual({ hash: contentHash('theirs\n') })
    expect(handle.state().conflict).toEqual({
      kind: 'changed',
      baseText: 'line one\nline two\n',
      diskText: 'theirs\n',
      diskHash: contentHash('theirs\n'),
    })
    expect(await fs.readFile(file, 'utf8')).toBe('theirs\n')
    handle.close()
  })

  it('persists unsaved edits to <data>/buffers and restores them in a new runtime', async () => {
    const handle = await ws.files.buffers.open(file)
    handle.text.insert(0, 'unsaved ')
    handle.close()
    // Dirty, so it stays loaded without a holder.
    expect(ws.files.buffers.openPaths()).toEqual([file])
    await ws.files.buffers.flush()
    expect(await bufferFiles()).toHaveLength(1)

    const next = createFilesRuntime({ ...ws.deps })
    try {
      expect(await next.buffers.restore()).toEqual([file])
      const restored = await next.buffers.open(file)
      expect(restored.text.toString()).toBe('unsaved line one\nline two\n')
      expect(restored.state()).toMatchObject({ dirty: true, baseHash: contentHash('line one\nline two\n'), conflict: null })
      await restored.save()
      expect(await fs.readFile(file, 'utf8')).toBe('unsaved line one\nline two\n')
      restored.close()
      await until(async () => (await bufferFiles()).length === 0)
      expect(next.buffers.openPaths()).toEqual([])
    } finally {
      await next.dispose()
    }
  })

  it('a restored buffer whose file changed meanwhile comes back conflicting', async () => {
    const handle = await ws.files.buffers.open(file)
    handle.text.insert(0, 'unsaved ')
    await ws.files.buffers.flush()
    handle.close()
    await fs.writeFile(file, 'edited elsewhere\n')
    const next = createFilesRuntime({ ...ws.deps })
    try {
      await next.buffers.restore()
      const restored = await next.buffers.open(file)
      expect(restored.state().conflict).toMatchObject({ kind: 'changed', diskText: 'edited elsewhere\n' })
      restored.close()
    } finally {
      await next.dispose()
    }
  })

  it('reloads a clean buffer on an external change', async () => {
    const handle = await ws.files.buffers.open(file)
    const states: boolean[] = []
    handle.subscribe((s) => states.push(s.dirty))
    await fs.writeFile(file, 'line one\nline 2\n')
    ws.watcher.fire(file, 'update')
    await until(() => handle.text.toString() === 'line one\nline 2\n')
    expect(handle.state()).toMatchObject({ dirty: false, conflict: null, baseHash: contentHash('line one\nline 2\n') })
    handle.close()
  })

  it('marks a dirty buffer conflicting on an external change, and resolves it', async () => {
    const handle = await ws.files.buffers.open(file)
    handle.text.insert(0, 'mine\n')
    await fs.writeFile(file, 'line one\nline two\ntheirs\n')
    ws.watcher.fire(file, 'update')
    await until(() => handle.state().conflict !== null)
    expect(handle.state().conflict).toEqual({
      kind: 'changed',
      baseText: 'line one\nline two\n',
      diskText: 'line one\nline two\ntheirs\n',
      diskHash: contentHash('line one\nline two\ntheirs\n'),
    })
    expect(handle.text.toString()).toBe('mine\nline one\nline two\n')

    const merged = await handle.resolveConflict('merge')
    expect(handle.text.toString()).toBe('mine\nline one\nline two\ntheirs\n')
    expect(merged).toMatchObject({ conflict: null, dirty: true, baseHash: contentHash('line one\nline two\ntheirs\n') })
    await handle.save()
    expect(await fs.readFile(file, 'utf8')).toBe('mine\nline one\nline two\ntheirs\n')
    handle.close()
  })

  it('keep adopts the disk as base; reload drops the edits', async () => {
    const handle = await ws.files.buffers.open(file)
    handle.text.insert(0, 'mine ')
    await fs.writeFile(file, 'theirs\n')
    ws.watcher.fire(file, 'update')
    await until(() => handle.state().conflict !== null)
    await handle.resolveConflict('keep')
    expect(handle.state()).toMatchObject({ conflict: null, dirty: true, baseHash: contentHash('theirs\n') })
    await handle.save()
    expect(await fs.readFile(file, 'utf8')).toBe('mine line one\nline two\n')

    handle.text.insert(0, 'more ')
    await handle.resolveConflict('reload')
    expect(handle.text.toString()).toBe('mine line one\nline two\n')
    expect(handle.state().dirty).toBe(false)
    handle.close()
  })

  it('a deleted file conflicts, and keep then save recreates it', async () => {
    const handle = await ws.files.buffers.open(file)
    await fs.rm(file)
    ws.watcher.fire(file, 'delete')
    await until(() => handle.state().conflict !== null)
    expect(handle.state().conflict).toEqual({ kind: 'deleted', baseText: 'line one\nline two\n' })
    await expect(handle.save()).rejects.toMatchObject({ code: 'conflict' })
    await handle.resolveConflict('keep')
    expect(handle.state()).toMatchObject({ baseHash: null, dirty: true })
    await handle.save()
    expect(await fs.readFile(file, 'utf8')).toBe('line one\nline two\n')
    handle.close()
  })

  it('its own save does not look like an external change', async () => {
    const handle = await ws.files.buffers.open(file)
    handle.text.insert(0, 'x')
    await handle.save()
    ws.watcher.fire(file, 'update')
    await new Promise((r) => setTimeout(r, 20))
    expect(handle.state()).toMatchObject({ dirty: false, conflict: null })
    handle.close()
  })

  it('is dropped when clean and nobody holds it', async () => {
    const a = await ws.files.buffers.open(file)
    const b = await ws.files.buffers.open(file)
    a.close()
    expect(ws.files.buffers.openPaths()).toEqual([file])
    b.close()
    expect(ws.files.buffers.openPaths()).toEqual([])
    // Watching stops with it.
    await until(() => ws.watcher.roots().length === 0)

    const dirty = await ws.files.buffers.open(file)
    dirty.text.insert(0, 'x')
    dirty.close()
    expect(ws.files.buffers.openPaths()).toEqual([file])
    await until(async () => (await bufferFiles()).length === 1)
    await ws.files.buffers.resolveConflict(file, 'reload')
    expect(ws.files.buffers.openPaths()).toEqual([])
    await until(async () => (await bufferFiles()).length === 0)
  })

  it('a remote subscriber holds the buffer until its stream ends', async () => {
    const one = await ws.connect()
    const attached = attachBuffer(one.file, file, new Y.Doc())
    await attached.ready
    expect(ws.files.buffers.openPaths()).toEqual([file])
    attached.close()
    await until(() => ws.files.buffers.openPaths().length === 0)
  })

  it('refuses a file outside the workspace', async () => {
    await expect(ws.files.buffers.open(path.join(ws.base, 'x.md'))).rejects.toMatchObject({ code: 'rejected' })
  })
})
