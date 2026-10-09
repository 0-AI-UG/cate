import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { copyInto, moveToTrash, readDir, removeEntry, searchFileNames, writeAtomic } from './fileOps'

const posixIt = process.platform === 'win32' ? it.skip : it

let dir: string
beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'cate-file-ops-')))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('writeAtomic', () => {
  it('writes content and leaves no tmp file behind', async () => {
    const target = path.join(dir, 'a.json')
    await writeAtomic(target, '{"ok":true}')
    expect(await fs.readFile(target, 'utf8')).toBe('{"ok":true}')
    expect(await fs.readdir(dir)).toEqual(['a.json'])
  })

  it('creates missing parent directories and overwrites completely', async () => {
    const target = path.join(dir, 'nested', 'deep', 'b.txt')
    await writeAtomic(target, 'long original content')
    await writeAtomic(target, 'short')
    expect(await fs.readFile(target, 'utf8')).toBe('short')
  })

  posixIt('preserves the existing file mode (executable bit survives a save)', async () => {
    const target = path.join(dir, 'script.sh')
    await writeAtomic(target, '#!/bin/sh\necho one\n')
    await fs.chmod(target, 0o755)
    await writeAtomic(target, '#!/bin/sh\necho two\n')
    expect((await fs.stat(target)).mode & 0o7777).toBe(0o755)
  })

  posixIt('refuses to write through a symlink', async () => {
    const real = path.join(dir, 'real.txt')
    const link = path.join(dir, 'link.txt')
    await fs.writeFile(real, 'original')
    await fs.symlink(real, link)
    await expect(writeAtomic(link, 'clobber')).rejects.toThrow(/symbolic link/)
    expect(await fs.readFile(real, 'utf-8')).toBe('original')
  })

  it('round-trips bytes', async () => {
    const target = path.join(dir, 'blob.bin')
    const bytes = new Uint8Array([0, 1, 2, 255, 254, 128])
    await writeAtomic(target, bytes)
    expect(new Uint8Array(await fs.readFile(target))).toEqual(bytes)
  })
})

describe('readDir', () => {
  posixIt('lists directories first, skips exclusions and symlinks, keeps dotfiles', async () => {
    await fs.mkdir(path.join(dir, 'src'))
    await fs.mkdir(path.join(dir, 'node_modules'))
    await fs.writeFile(path.join(dir, 'b.ts'), '')
    await fs.writeFile(path.join(dir, 'A.md'), '')
    await fs.writeFile(path.join(dir, '.env'), '')
    await fs.symlink(path.join(dir, 'b.ts'), path.join(dir, 'link.ts'))
    const entries = await readDir(dir, new Set(['node_modules']))
    expect(entries.map((e) => e.name)).toEqual(['src', '.env', 'A.md', 'b.ts'])
    expect(entries[3]).toEqual({ name: 'b.ts', path: path.join(dir, 'b.ts'), isDirectory: false, extension: 'ts' })
  })

  it('returns nothing for a missing directory', async () => {
    expect(await readDir(path.join(dir, 'nope'), new Set())).toEqual([])
  })
})

describe('searchFileNames', () => {
  it('matches names, skips dotfiles unless asked, shortest paths first', async () => {
    await fs.mkdir(path.join(dir, 'deep', 'er'), { recursive: true })
    await fs.writeFile(path.join(dir, 'deep', 'er', 'widget.ts'), '')
    await fs.writeFile(path.join(dir, 'widget.md'), '')
    await fs.writeFile(path.join(dir, '.widgetrc'), '')
    const results = await searchFileNames(dir, 'widget', new Set())
    expect(results.map((r) => r.relativePath)).toEqual(['widget.md', 'deep/er/widget.ts'])
    expect((await searchFileNames(dir, '.widget', new Set())).map((r) => r.name)).toEqual(['.widgetrc'])
  })
})

describe('copyInto', () => {
  it('names a copy in the same directory "x copy", elsewhere "x (2)"', async () => {
    await fs.writeFile(path.join(dir, 'a.txt'), '1')
    await fs.mkdir(path.join(dir, 'sub'))
    await fs.writeFile(path.join(dir, 'sub', 'a.txt'), '2')
    expect(await copyInto(path.join(dir, 'a.txt'), dir)).toBe(path.join(dir, 'a copy.txt'))
    expect(await copyInto(path.join(dir, 'a.txt'), dir)).toBe(path.join(dir, 'a copy 2.txt'))
    expect(await copyInto(path.join(dir, 'a.txt'), path.join(dir, 'sub'))).toBe(path.join(dir, 'sub', 'a (2).txt'))
  })

  it('refuses to copy a folder into itself', async () => {
    await fs.mkdir(path.join(dir, 'f'))
    await expect(copyInto(dir, path.join(dir, 'f'))).rejects.toThrow()
  })
})

describe('moveToTrash', () => {
  it('moves into ~/.Trash on macOS', async () => {
    const home = path.join(dir, 'home')
    const target = path.join(dir, 'gone.txt')
    await fs.writeFile(target, 'x')
    expect(await moveToTrash(target, home, 'darwin')).toBe(true)
    expect(await fs.readdir(path.join(home, '.Trash'))).toEqual(['gone.txt'])
  })

  it('writes a trashinfo on Linux', async () => {
    const home = path.join(dir, 'home')
    const target = path.join(dir, 'gone.txt')
    await fs.writeFile(target, 'x')
    const prev = process.env.XDG_DATA_HOME
    delete process.env.XDG_DATA_HOME
    try {
      expect(await moveToTrash(target, home, 'linux')).toBe(true)
    } finally {
      if (prev !== undefined) process.env.XDG_DATA_HOME = prev
    }
    const trash = path.join(home, '.local', 'share', 'Trash')
    expect(await fs.readdir(path.join(trash, 'files'))).toEqual(['gone.txt'])
    expect(await fs.readFile(path.join(trash, 'info', 'gone.txt.trashinfo'), 'utf8')).toContain('[Trash Info]')
  })

  it('reports no trash on Windows', async () => {
    const target = path.join(dir, 'kept.txt')
    await fs.writeFile(target, 'x')
    expect(await moveToTrash(target, dir, 'win32')).toBe(false)
    await removeEntry(target)
    await expect(fs.stat(target)).rejects.toThrow()
  })
})
