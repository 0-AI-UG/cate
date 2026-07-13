// Atomic write behavior of the daemon file capability: tmp+rename (no stray
// tmp left behind), existing-mode preservation across the inode swap, symlink
// refusal, and parent-dir creation. Same code serves local and remote hosts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import { writeFile, writeBinary, readFile } from './file'

const posixIt = process.platform === 'win32' ? it.skip : it

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'cate-file-cap-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('writeFile (atomic)', () => {
  it('writes content and leaves no tmp file behind', async () => {
    const target = path.join(dir, 'a.json')
    await writeFile(target, '{"ok":true}')
    expect(await readFile(target)).toBe('{"ok":true}')
    expect(await fs.readdir(dir)).toEqual(['a.json'])
  })

  it('creates missing parent directories', async () => {
    const target = path.join(dir, 'nested', 'deep', 'b.txt')
    await writeFile(target, 'x')
    expect(await readFile(target)).toBe('x')
  })

  it('overwrites an existing file completely', async () => {
    const target = path.join(dir, 'c.txt')
    await writeFile(target, 'long original content')
    await writeFile(target, 'short')
    expect(await readFile(target)).toBe('short')
    expect(await fs.readdir(dir)).toEqual(['c.txt'])
  })

  posixIt('preserves the existing file mode across the rename (executable bit survives a save)', async () => {
    const target = path.join(dir, 'script.sh')
    await writeFile(target, '#!/bin/sh\necho one\n')
    await fs.chmod(target, 0o755)
    await writeFile(target, '#!/bin/sh\necho two\n')
    const mode = (await fs.stat(target)).mode & 0o7777
    expect(mode).toBe(0o755)
  })

  posixIt('refuses to write through a symlink', async () => {
    const real = path.join(dir, 'real.txt')
    const link = path.join(dir, 'link.txt')
    await fs.writeFile(real, 'original')
    await fs.symlink(real, link)
    await expect(writeFile(link, 'clobber')).rejects.toThrow(/symbolic link/)
    expect(await fs.readFile(real, 'utf-8')).toBe('original')
  })
})

describe('writeBinary (atomic)', () => {
  it('round-trips bytes and leaves no tmp file behind', async () => {
    const target = path.join(dir, 'blob.bin')
    const bytes = Buffer.from([0, 1, 2, 255, 254, 128])
    await writeBinary(target, bytes)
    expect(await fs.readFile(target)).toEqual(bytes)
    expect(await fs.readdir(dir)).toEqual(['blob.bin'])
  })
})
