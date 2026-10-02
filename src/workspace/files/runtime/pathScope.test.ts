import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { isRpcError } from '@kernel/rpc/contract'
import { createPathScope, pathCompareKey, worktreesDir, type PathScope } from './pathScope'

const posixTest = process.platform === 'win32' ? test.skip : test

describe('path scope', () => {
  let base: string
  let rootDir: string
  let dataDir: string
  let outsideDir: string
  let scope: PathScope

  beforeEach(async () => {
    base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cate-scope-')))
    rootDir = path.join(base, 'root')
    dataDir = path.join(base, 'data')
    outsideDir = path.join(base, 'outside')
    await Promise.all([rootDir, dataDir, outsideDir].map((d) => fs.mkdir(d, { recursive: true })))
    scope = createPathScope({ root: rootDir, dataDir })
  })

  afterEach(async () => {
    scope.dispose()
    vi.restoreAllMocks()
    await fs.rm(base, { recursive: true, force: true })
  })

  test('accepts the root, its worktree checkouts dir and the readable data folders', async () => {
    expect(scope.resolve(path.join(rootDir, 'a.txt'))).toBe(path.join(rootDir, 'a.txt'))
    expect(scope.resolve(rootDir)).toBe(rootDir)
    await expect(scope.strict(path.join(worktreesDir(rootDir), 'feat', 'x.ts'))).resolves.toContain('feat')
    await expect(scope.strict(path.join(dataDir, 'screenshots', 'a.png'))).resolves.toBe(path.join(dataDir, 'screenshots', 'a.png'))
    await expect(scope.strict(path.join(dataDir, 'browser', 'downloads', 'r.pdf'))).resolves.toContain('r.pdf')
    // The rest of the workspace data is outside the scope.
    for (const name of ['secrets.json', 'pairings.json', 'browser/history.json', '']) {
      await expect(scope.strict(path.join(dataDir, name))).rejects.toThrow(/outside the workspace/)
    }
  })

  test('the workspace data is never written, created, removed or moved', async () => {
    await fs.writeFile(path.join(dataDir, 'secrets.json'), '{}')
    for (const p of [path.join(dataDir, 'secrets.json'), path.join(dataDir, 'screenshots', 'a.png'), dataDir]) {
      const created = await scope.forCreation(p).catch((e: unknown) => e)
      const entry = await scope.entry(p).catch((e: unknown) => e)
      expect(isRpcError(created, 'rejected')).toBe(true)
      expect(isRpcError(entry, 'rejected')).toBe(true)
    }
  })

  test('refuses a path outside the workspace with rejected', async () => {
    const outside = path.join(outsideDir, 'secret.txt')
    await fs.writeFile(outside, 'x')
    const lexical = (() => { try { scope.resolve(outside) } catch (e) { return e } })()
    expect(isRpcError(lexical, 'rejected')).toBe(true)
    await expect(scope.strict(outside)).rejects.toThrow(/outside the workspace/)
    await expect(scope.forCreation(outside)).rejects.toThrow(/outside the workspace/)
    await expect(scope.entry(outside)).rejects.toThrow(/outside the workspace/)
    // No temp dir allowance any more.
    expect(() => scope.resolve(path.join(os.tmpdir(), 'x'))).toThrow(/outside the workspace/)
    expect(() => scope.resolve('')).toThrow(/invalid path/)
  })

  test('refuses a sibling sharing the root name stem', () => {
    expect(() => scope.resolve(rootDir + '-evil/file')).toThrow(/outside the workspace/)
  })

  describe('worktree checkouts', () => {
    test('a checkout outside the root is allowed while registered', async () => {
      const checkout = path.join(outsideDir, 'wt')
      await fs.mkdir(checkout)
      const probe = path.join(checkout, 'file.txt')
      expect(() => scope.resolve(probe)).toThrow()
      scope.addCheckout(checkout)
      expect(scope.checkouts()).toEqual([checkout])
      expect(scope.resolve(probe)).toBe(probe)
      await expect(scope.strict(probe)).resolves.toBe(probe)
      scope.removeCheckout(checkout)
      expect(() => scope.resolve(probe)).toThrow(/outside the workspace/)
    })
  })

  describe('destinations', () => {
    test('files are brought only into a checkout, the innermost one named', async () => {
      const nested = path.join(worktreesDir(rootDir), 'feat')
      const outside = path.join(outsideDir, 'wt')
      await fs.mkdir(nested, { recursive: true })
      await fs.mkdir(outside)
      scope.addCheckout(nested)
      scope.addCheckout(outside)
      await expect(scope.destination(path.join(rootDir, 'src'))).resolves.toBe(path.join(rootDir, 'src'))
      expect(scope.checkoutOf(path.join(rootDir, 'src'))).toBe(rootDir)
      expect(scope.checkoutOf(path.join(nested, 'src'))).toBe(nested)
      expect(scope.checkoutOf(outside)).toBe(outside)
      await expect(scope.destination(outside)).resolves.toBe(outside)
    })

    test('the workspace data, a grant and anywhere outside never receive files', async () => {
      await scope.grant(outsideDir)
      for (const dir of [dataDir, path.join(dataDir, 'screenshots'), outsideDir, base]) {
        const error = await scope.destination(dir).catch((e: unknown) => e)
        expect(isRpcError(error, 'rejected')).toBe(true)
        expect(scope.checkoutOf(dir)).toBeNull()
      }
      // Still readable: only bringing files in is refused.
      await expect(scope.strict(outsideDir)).resolves.toBe(outsideDir)
    })
  })

  describe('grants', () => {
    test('a granted file is readable and writable, and persists in grants.json', async () => {
      const target = path.join(outsideDir, 'saved.txt')
      await fs.writeFile(target, 'hello')
      await expect(scope.strict(target)).rejects.toThrow()

      await expect(scope.grant(target)).resolves.toBe(target)
      await expect(scope.strict(target)).resolves.toBe(target)
      await expect(scope.forCreation(target)).resolves.toBe(target)
      expect(JSON.parse(await fs.readFile(path.join(dataDir, 'grants.json'), 'utf8'))).toEqual([target])

      // A new daemon for the same workspace reads the grant back.
      const again = createPathScope({ root: rootDir, dataDir })
      try {
        await expect(again.strict(target)).resolves.toBe(target)
        expect(again.grants()).toEqual([target])
      } finally {
        again.dispose()
      }

      await scope.revokeGrant(target)
      await expect(scope.strict(target)).rejects.toThrow(/outside the workspace/)
      expect(JSON.parse(await fs.readFile(path.join(dataDir, 'grants.json'), 'utf8'))).toEqual([])
    })

    test('a granted directory covers its contents', async () => {
      await scope.grant(outsideDir)
      await expect(scope.forCreation(path.join(outsideDir, 'new', 'deep.txt'))).resolves.toContain('deep.txt')
    })

    test('a grant does not reach a sibling', async () => {
      await scope.grant(path.join(outsideDir, 'a.txt'))
      await expect(scope.strict(path.join(outsideDir, 'b.txt'))).rejects.toThrow()
    })
  })

  describe('not-yet-created paths', () => {
    test('strict resolves a deep missing path under the root', async () => {
      const missing = path.join(rootDir, '.cate', 'cache', 'sessions', 'x')
      await expect(scope.strict(missing)).resolves.toBe(missing)
    })

    test('forCreation allows a target whose parent chain is missing', async () => {
      const dest = path.join(rootDir, 'a', 'b', 'c.txt')
      await expect(scope.forCreation(dest)).resolves.toBe(dest)
    })

    posixTest('still rejects a symlink that escapes the root, even for a missing leaf', async () => {
      const link = path.join(rootDir, 'escape')
      await fs.symlink(outsideDir, link)
      await expect(scope.strict(path.join(link, 'new-file.txt'))).rejects.toThrow(/outside the workspace/)
    })
  })

  describe('symlinked creation targets', () => {
    posixTest('rejects creation through a symlinked dir pointing outside', async () => {
      const link = path.join(rootDir, 'escape-dir')
      await fs.symlink(outsideDir, link)
      await expect(scope.forCreation(path.join(link, 'new.txt'))).rejects.toThrow(/outside the workspace/)
    })

    posixTest('rejects an existing symlink as the creation target', async () => {
      const real = path.join(rootDir, 'real.txt')
      await fs.writeFile(real, 'data')
      const link = path.join(rootDir, 'link.txt')
      await fs.symlink(real, link)
      await expect(scope.forCreation(link)).rejects.toThrow(/symbolic link/)
    })

    posixTest('entry does not follow a final symlink', async () => {
      const real = path.join(outsideDir, 'real.txt')
      await fs.writeFile(real, 'data')
      const link = path.join(rootDir, 'link.txt')
      await fs.symlink(real, link)
      await expect(scope.entry(link)).resolves.toBe(link)
      await expect(scope.strict(link)).rejects.toThrow(/outside the workspace/)
    })

    test('rejects an invalid entry name', async () => {
      await expect(scope.forCreation(path.join(rootDir, '..'))).rejects.toThrow()
    })
  })

  describe('realpath fallback', () => {
    test('uses the JS resolver when the native one fails on an existing path', async () => {
      const target = path.join(rootDir, 'file.txt')
      await fs.writeFile(target, 'data')
      vi.spyOn(fs, 'realpath').mockRejectedValueOnce(Object.assign(new Error('unknown'), { code: 'UNKNOWN' }))
      await expect(scope.strict(target)).resolves.toBe(fsSync.realpathSync(target))
    })

    test('fails closed when both resolvers reject', async () => {
      const target = path.join(rootDir, 'file.txt')
      await fs.writeFile(target, 'data')
      const error = Object.assign(new Error('I/O failure'), { code: 'EIO' })
      vi.spyOn(fs, 'realpath').mockRejectedValue(error)
      vi.spyOn(fsSync, 'realpathSync').mockImplementation(() => { throw error })
      await expect(scope.strict(target)).rejects.toThrow(/cannot resolve real path/)
    })
  })

  describe('pathCompareKey', () => {
    test('win32 is case-insensitive, posix is not', () => {
      expect(pathCompareKey('C:\\Users\\Alice', 'win32')).toBe('c:\\users\\alice')
      expect(pathCompareKey('/Users/Alice', 'linux')).toBe('/Users/Alice')
    })
  })
})
