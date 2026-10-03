// The file and search capabilities end to end: runtime, rpc and the fs client.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { isRpcError } from '@kernel/rpc/contract'
import { contentHash, type FsChange } from './contract'
import { createWatchManager } from './client'
import { makeWorkspace, tick, until } from './testing.test-helpers'

let ws: Awaited<ReturnType<typeof makeWorkspace>>
beforeEach(async () => { ws = await makeWorkspace() })
afterEach(async () => { await ws.dispose() })

describe('file capability', () => {
  it('reads text with the hash of its bytes', async () => {
    const { fs: client } = await ws.connect()
    await fs.writeFile(path.join(ws.root, 'a.txt'), 'hello')
    await expect(client.read(path.join(ws.root, 'a.txt'))).resolves.toEqual({ content: 'hello', hash: contentHash('hello') })
  })

  it('writes against a base hash and refuses a stale one with conflict', async () => {
    const { fs: client } = await ws.connect()
    const file = path.join(ws.root, 'a.txt')
    const created = await client.write(file, 'one', null)
    expect(created.hash).toBe(contentHash('one'))
    // null base: the file must not exist yet.
    const exists = await client.write(file, 'x', null).catch((e) => e)
    expect(isRpcError(exists, 'conflict')).toBe(true)

    await client.write(file, 'two', created.hash)
    const stale = await client.write(file, 'three', created.hash).catch((e) => e)
    expect(isRpcError(stale, 'conflict')).toBe(true)
    expect(stale.data).toEqual({ hash: contentHash('two') })
    expect(await fs.readFile(file, 'utf8')).toBe('two')
    // No base: unconditional.
    await client.write(file, 'four')
    expect(await fs.readFile(file, 'utf8')).toBe('four')
  })

  it('refuses paths outside the workspace', async () => {
    const { fs: client } = await ws.connect()
    const err = await client.read(path.join(ws.base, 'elsewhere.txt')).catch((e) => e)
    expect(isRpcError(err, 'rejected')).toBe(true)
  })

  it('serves a granted path', async () => {
    const { fs: client } = await ws.connect()
    const outside = path.join(ws.base, 'picked.txt')
    await fs.writeFile(outside, 'picked')
    await client.grant(outside)
    await expect(client.read(outside)).resolves.toMatchObject({ content: 'picked' })
  })

  it('round-trips binary files larger than one chunk', async () => {
    const { fs: client } = await ws.connect()
    const bytes = new Uint8Array(600 * 1024).map((_, i) => i % 251)
    const file = path.join(ws.root, 'blob.bin')
    const res = await client.writeBinary(file, bytes)
    expect(res.hash).toBe(contentHash(bytes))
    expect(new Uint8Array(await fs.readFile(file))).toEqual(bytes)
    expect(await client.readBinary(file)).toEqual(bytes)
  })

  it('lists, stats, renames, copies, removes and makes directories', async () => {
    const { fs: client } = await ws.connect()
    await client.mkdir(path.join(ws.root, 'src', 'deep'))
    await client.write(path.join(ws.root, 'src', 'a.ts'), 'a')
    expect((await client.readDir(path.join(ws.root, 'src'))).map((e) => e.name)).toEqual(['deep', 'a.ts'])
    expect(await client.stat(path.join(ws.root, 'src', 'a.ts'))).toMatchObject({ isFile: true, size: 1 })
    const moved = await client.rename(path.join(ws.root, 'src', 'a.ts'), path.join(ws.root, 'b.ts'))
    expect(moved.path).toBe(path.join(ws.root, 'b.ts'))
    const copy = await client.copy(path.join(ws.root, 'b.ts'), ws.root)
    expect(copy.path).toBe(path.join(ws.root, 'b copy.ts'))
    await client.remove(path.join(ws.root, 'src'))
    expect((await client.readDir(ws.root)).map((e) => e.name)).toEqual(['b copy.ts', 'b.ts'])
  })

  it('trashes, or deletes permanently where there is no trash', async () => {
    await ws.dispose()
    ws = await makeWorkspace({ trash: async () => false })
    const { fs: client } = await ws.connect()
    const file = path.join(ws.root, 'x.txt')
    await fs.writeFile(file, 'x')
    await expect(client.trash(file)).resolves.toEqual({ permanent: true })
    await expect(fs.stat(file)).rejects.toThrow()
  })

  it('imports dropped entries as an upload, renaming on collision', async () => {
    const { fs: client } = await ws.connect()
    await fs.mkdir(path.join(ws.root, 'dest'))
    await fs.writeFile(path.join(ws.root, 'dest', 'notes.txt'), 'existing')
    const big = new Uint8Array(300 * 1024).fill(7)
    const result = await client.importEntries(path.join(ws.root, 'dest'), [
      { path: 'notes.txt', kind: 'file', size: 3, bytes: new TextEncoder().encode('new') },
      { path: 'folder', kind: 'dir' },
      { path: 'folder/inner', kind: 'dir' },
      { path: 'folder/inner/big.bin', kind: 'file', size: big.length, bytes: async function* () { yield big.subarray(0, 1000); yield big.subarray(1000) } },
      { path: '../escape.txt', kind: 'file', size: 2, bytes: new Uint8Array([1, 2]) },
      { path: 'after.txt', kind: 'file', size: 1, bytes: new Uint8Array([65]) },
    ])
    expect(result.failed).toBe(1)
    expect(result.created.sort()).toEqual([
      path.join(ws.root, 'dest', 'after.txt'),
      path.join(ws.root, 'dest', 'folder'),
      path.join(ws.root, 'dest', 'notes (2).txt'),
    ])
    expect(await fs.readFile(path.join(ws.root, 'dest', 'notes (2).txt'), 'utf8')).toBe('new')
    expect(await fs.readFile(path.join(ws.root, 'dest', 'notes.txt'), 'utf8')).toBe('existing')
    expect(new Uint8Array(await fs.readFile(path.join(ws.root, 'dest', 'folder', 'inner', 'big.bin')))).toEqual(big)
    expect(await fs.readFile(path.join(ws.root, 'dest', 'after.txt'), 'utf8')).toBe('A')
    await expect(fs.stat(path.join(ws.root, 'escape.txt'))).rejects.toThrow()
  })

  it('stores a finished browser download in the workspace data', async () => {
    const { fs: client } = await ws.connect()
    const { path: stored } = await client.storeDownload('../report.pdf', new Uint8Array([1, 2, 3]))
    expect(path.dirname(stored)).toBe(path.join(ws.data, 'browser', 'downloads'))
    expect(path.basename(stored)).toMatch(/^\d+-report\.pdf$/)
    expect([...(await fs.readFile(stored))]).toEqual([1, 2, 3])
  })

  it('stores a screenshot in the workspace data', async () => {
    const { fs: client } = await ws.connect()
    const { path: stored } = await client.storeScreenshot('shot-annotated.png', new Uint8Array([4, 5]))
    expect(path.dirname(stored)).toBe(path.join(ws.data, 'screenshots'))
    expect(path.basename(stored)).toMatch(/^\d+-shot-annotated\.png$/)
    expect([...(await fs.readFile(stored))]).toEqual([4, 5])
  })

  it('brings files only into a checkout: uploads, copies and moves into the workspace data are refused', async () => {
    const { fs: client } = await ws.connect()
    const source = path.join(ws.root, 'a.txt')
    await fs.writeFile(source, 'a')
    await fs.mkdir(path.join(ws.data, 'screenshots'), { recursive: true })
    const refused = async (call: Promise<unknown>) => {
      const error = await call.catch((err: unknown) => err)
      expect(isRpcError(error) && error.code).toBe('rejected')
    }
    await refused(client.importEntries(ws.data, [{ path: 'x.txt', kind: 'file', size: 1, bytes: new Uint8Array([1]) }]))
    await refused(client.copy(source, path.join(ws.data, 'screenshots')))
    await refused(client.rename(source, path.join(ws.data, 'a.txt')))
    expect(await fs.readdir(path.join(ws.data, 'screenshots'))).toEqual([])
    expect(await fs.readFile(source, 'utf8')).toBe('a')
  })

  it('reads only screenshots and downloads of the workspace data, and never writes it', async () => {
    const { fs: client } = await ws.connect()
    const secrets = path.join(ws.data, 'secrets.json')
    await fs.writeFile(secrets, '{"token":"x"}')
    const { path: shot } = await client.storeScreenshot('shot.png', new Uint8Array([1]))
    const { path: download } = await client.storeDownload('report.pdf', new Uint8Array([2]))
    const refused = async (call: Promise<unknown>) => {
      const error = await call.catch((err: unknown) => err)
      expect(isRpcError(error) && error.code).toBe('rejected')
    }
    // Readable: what clients and agents are handed.
    expect([...await client.readBinary(shot)]).toEqual([1])
    expect([...await client.readBinary(download)]).toEqual([2])
    // The rest of the workspace data is outside the scope.
    await refused(client.read(secrets))
    await refused(client.readBinary(path.join(ws.data, 'pairings.json')))
    await refused(client.readDir(ws.data))
    // And nothing in it is written, created, removed or moved.
    for (const p of [secrets, shot]) {
      await refused(client.write(p, '{}'))
      await refused(client.writeBinary(p, new Uint8Array([9])))
      await refused(client.remove(p))
      await refused(client.trash(p))
      await refused(client.rename(p, path.join(ws.root, 'moved')))
    }
    await refused(client.mkdir(path.join(ws.data, 'screenshots', 'new')))
    expect(await fs.readFile(secrets, 'utf8')).toBe('{"token":"x"}')
    expect([...await fs.readFile(shot)]).toEqual([1])
  })

  it('gives the temporary folder of the checkout holding near, and refuses a near no checkout holds', async () => {
    const { fs: client } = await ws.connect()
    await fs.mkdir(path.join(ws.root, 'src'))
    const tmp = path.join(ws.root, '.cate', 'tmp')
    expect(await client.tempDir()).toBe(tmp)
    expect(await client.tempDir(path.join(ws.root, 'src'))).toBe(tmp)
    // Outside the workspace, and the workspace data: never redirected to the root.
    for (const near of [ws.base, ws.data]) {
      const error = await client.tempDir(near).catch((err: unknown) => err)
      expect(isRpcError(error) && error.code).toBe('rejected')
    }
  })

  it('streams batched watch events and a refcounted client watch shares one stream', async () => {
    const { file } = await ws.connect()
    const manager = createWatchManager(() => file)
    const a: FsChange[] = []
    const b: FsChange[] = []
    const stopA = manager.watch('w', ws.root, (c) => a.push(c))
    const stopB = manager.watch('w', ws.root, (c) => b.push(c))
    expect(manager.size()).toBe(1)
    await until(() => ws.watcher.roots().includes(ws.root))
    const changed = path.join(ws.root, 'x.ts')
    ws.watcher.fire(changed, 'create')
    ws.watcher.fire(changed, 'update')
    await until(() => a.length > 0)
    // Coalesced per path: the last type wins.
    expect(a).toEqual([{ path: changed, type: 'update' }])
    expect(b).toEqual(a)
    stopA()
    expect(manager.size()).toBe(1)
    stopB()
    expect(manager.size()).toBe(0)
    await until(() => !ws.watcher.roots().includes(ws.root))
  })
})

describe('search capability', () => {
  it('finds file names under the workspace root by default', async () => {
    const { fs: client } = await ws.connect()
    await fs.mkdir(path.join(ws.root, 'node_modules'))
    await fs.writeFile(path.join(ws.root, 'node_modules', 'widget.js'), '')
    await fs.writeFile(path.join(ws.root, 'widget.ts'), '')
    const results = await client.searchFiles('widget')
    expect(results.map((r) => r.relativePath)).toEqual(['widget.ts'])
  })

  const rg = (() => {
    try {
      return execFileSync(process.platform === 'win32' ? 'where' : 'which', ['rg'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim()
    } catch {
      return ''
    }
  })()

  it.skipIf(!rg)('streams ripgrep content matches', async () => {
    await ws.dispose()
    ws = await makeWorkspace({ rgPath: rg })
    const { fs: client } = await ws.connect()
    await fs.writeFile(path.join(ws.root, 'a.txt'), 'one needle\ntwo\nneedle again\n')
    await fs.writeFile(path.join(ws.root, 'b.txt'), 'nothing here\n')
    const batches: string[] = []
    const search = client.searchContent({ query: 'needle' }, (files) => batches.push(...files.map((f) => f.relativePath)))
    const done = await search.done
    expect(done.stats).toEqual({ matches: 2, files: 1, truncated: false })
    expect(batches).toEqual(['a.txt'])
  })

  it('ends an empty query at once', async () => {
    const { fs: client } = await ws.connect()
    const done = await client.searchContent({ query: '  ' }, () => {}).done
    expect(done.stats.matches).toBe(0)
    await tick()
  })
})
