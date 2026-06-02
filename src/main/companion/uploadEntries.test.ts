// Real-fs coverage for uploadEntriesToCompanion against the in-process
// localCompanion. The companion's file ops are plain fs against real paths, so
// we point sources/dest at temp dirs under os.tmpdir() and assert the bytes and
// tree that actually land on disk. No allowed-root setup is needed because the
// leaf ops are called directly.

import { mkdtemp, writeFile, readFile, mkdir, symlink, rm, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import posix from 'node:path/posix'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { uploadEntriesToCompanion } from './uploadEntries'
import { localCompanion } from './LocalCompanion'

let srcDir = ''
let destDir = ''

beforeEach(async () => {
  srcDir = await mkdtemp(path.join(os.tmpdir(), 'cate-upload-src-'))
  destDir = await mkdtemp(path.join(os.tmpdir(), 'cate-upload-dest-'))
})

afterEach(async () => {
  await rm(srcDir, { recursive: true, force: true }).catch(() => {})
  await rm(destDir, { recursive: true, force: true }).catch(() => {})
})

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

describe('uploadEntriesToCompanion', () => {
  test('copies a flat file byte-for-byte (binary safe)', async () => {
    const bytes = Buffer.from([0, 1, 2, 255])
    const src = path.join(srcDir, 'a.txt')
    await writeFile(src, bytes)

    const result = await uploadEntriesToCompanion(localCompanion, [src], destDir, 'copy')

    // uploadEntriesToCompanion targets a remote (POSIX) host, so created paths
    // are posix-joined even when localCompanion stands in on Windows.
    expect(result).toEqual({ created: [posix.join(destDir, 'a.txt')], failed: 0 })
    expect(await readFile(path.join(destDir, 'a.txt'))).toEqual(bytes)
    // copy leaves the source in place
    expect(await exists(src)).toBe(true)
  })

  test('auto-names on collision without clobbering the existing file', async () => {
    const original = Buffer.from('original')
    await writeFile(path.join(destDir, 'a.txt'), original)

    const incoming = Buffer.from('incoming')
    const src = path.join(srcDir, 'a.txt')
    await writeFile(src, incoming)

    const result = await uploadEntriesToCompanion(localCompanion, [src], destDir, 'copy')

    expect(result.failed).toBe(0)
    expect(result.created).toHaveLength(1)
    expect(path.basename(result.created[0])).toBe('a (2).txt')
    // original is untouched, the new copy carries the incoming bytes
    expect(await readFile(path.join(destDir, 'a.txt'))).toEqual(original)
    expect(await readFile(result.created[0])).toEqual(incoming)
  })

  test('move mode deletes the local source after upload', async () => {
    const src = path.join(srcDir, 'a.txt')
    await writeFile(src, Buffer.from('move me'))

    const result = await uploadEntriesToCompanion(localCompanion, [src], destDir, 'move')

    expect(result).toEqual({ created: [posix.join(destDir, 'a.txt')], failed: 0 })
    expect(await exists(path.join(destDir, 'a.txt'))).toBe(true)
    await expect(access(src)).rejects.toBeTruthy()
  })

  test('uploads a directory tree recursively', async () => {
    const dir = path.join(srcDir, 'dir')
    await mkdir(path.join(dir, 'sub'), { recursive: true })
    await writeFile(path.join(dir, 'x.txt'), Buffer.from('x-contents'))
    await writeFile(path.join(dir, 'sub', 'y.txt'), Buffer.from('y-contents'))

    const result = await uploadEntriesToCompanion(localCompanion, [dir], destDir, 'copy')

    expect(result.failed).toBe(0)
    expect(result.created).toEqual([posix.join(destDir, 'dir')])

    const x = path.join(destDir, 'dir', 'x.txt')
    const y = path.join(destDir, 'dir', 'sub', 'y.txt')
    expect(await readFile(x)).toEqual(Buffer.from('x-contents'))
    expect(await readFile(y)).toEqual(Buffer.from('y-contents'))
  })

  test('a top-level symlink resolves via realpath and uploads its target', async () => {
    // realpath is applied to the dragged path FIRST, so a top-level symlink is
    // followed to its target and DOES get uploaded (under the target's name).
    const real = path.join(srcDir, 'real.txt')
    const link = path.join(srcDir, 'link.txt')
    await writeFile(real, Buffer.from('real-bytes'))
    await symlink(real, link)

    const result = await uploadEntriesToCompanion(localCompanion, [link], destDir, 'copy')

    expect(result.failed).toBe(0)
    expect(result.created).toHaveLength(1)
    // named after the resolved target (real.txt), not the link
    expect(path.basename(result.created[0])).toBe('real.txt')
    expect(await readFile(result.created[0])).toEqual(Buffer.from('real-bytes'))
  })

  test('inner symlinks inside an uploaded directory are skipped', async () => {
    const d = path.join(srcDir, 'd')
    await mkdir(d, { recursive: true })
    await writeFile(path.join(d, 'f.txt'), Buffer.from('f-bytes'))
    await symlink(path.join(d, 'f.txt'), path.join(d, 'inner-link'))

    const result = await uploadEntriesToCompanion(localCompanion, [d], destDir, 'copy')

    expect(result.failed).toBe(0)
    expect(result.created).toEqual([posix.join(destDir, 'd')])

    // the regular file lands, the inner symlink is skipped by uploadOne
    expect(await readFile(path.join(destDir, 'd', 'f.txt'))).toEqual(Buffer.from('f-bytes'))
    expect(await exists(path.join(destDir, 'd', 'inner-link'))).toBe(false)
  })

  test('counts a nonexistent source as failed and creates nothing', async () => {
    const missing = path.join(srcDir, 'does-not-exist.txt')

    const result = await uploadEntriesToCompanion(localCompanion, [missing], destDir, 'copy')

    expect(result).toEqual({ created: [], failed: 1 })
  })
})
