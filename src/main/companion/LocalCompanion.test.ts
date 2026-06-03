import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { addAllowedRoot, removeAllowedRoot } from '../ipc/pathValidation'
import { readDir, searchFiles } from '../ipc/filesystem'
import { companions } from './companionManager'
import { localCompanion } from './LocalCompanion'
import { LOCAL_COMPANION_ID, formatLocator } from './locator'

// Phase 1 equivalence: routing through the local companion must produce the
// exact same results as calling the underlying filesystem functions directly.
describe('LocalCompanion', () => {
  let rootDir: string

  beforeEach(async () => {
    rootDir = await fs.realpath(await fs.mkdtemp(path.join(process.cwd(), 'cate-companion-')))
    addAllowedRoot(rootDir)
    await fs.writeFile(path.join(rootDir, 'alpha.ts'), 'const needle = 1\n')
    await fs.writeFile(path.join(rootDir, 'beta.md'), '# hello\n')
    await fs.mkdir(path.join(rootDir, 'sub'))
    await fs.writeFile(path.join(rootDir, 'sub', 'gamma.txt'), 'plain\n')
  })

  afterEach(async () => {
    removeAllowedRoot(rootDir)
    await fs.rm(rootDir, { recursive: true, force: true })
  })

  describe('registry', () => {
    test('resolve("local") returns the local companion', () => {
      const c = companions.resolve(LOCAL_COMPANION_ID)
      expect(c).toBe(localCompanion)
      expect(c.id).toBe(LOCAL_COMPANION_ID)
    })

    test('resolve of an unknown id throws', () => {
      expect(() => companions.resolve('srv_nope')).toThrow(/No companion registered/)
    })
  })

  describe('file host equivalence', () => {
    test('readDir matches the underlying function', async () => {
      const safe = await localCompanion.validatePathStrict(rootDir)
      const viaCompanion = await localCompanion.file.readDir(safe)
      const direct = await readDir(safe)
      expect(viaCompanion).toEqual(direct)
      // sanity: dirs first, then files, alphabetical
      expect(viaCompanion.map((n) => n.name)).toEqual(['sub', 'alpha.ts', 'beta.md'])
    })

    test('stat reports directory vs file', async () => {
      const dir = await localCompanion.validatePathStrict(rootDir)
      const file = await localCompanion.validatePathStrict(path.join(rootDir, 'alpha.ts'))
      expect(await localCompanion.file.stat(dir)).toEqual({ isDirectory: true, isFile: false })
      expect(await localCompanion.file.stat(file)).toEqual({ isDirectory: false, isFile: true })
    })

    test('readFile returns file contents', async () => {
      const file = await localCompanion.validatePathStrict(path.join(rootDir, 'alpha.ts'))
      expect(await localCompanion.file.readFile(file)).toBe('const needle = 1\n')
    })

    test('search matches the underlying function', async () => {
      const safe = await localCompanion.validatePathStrict(rootDir)
      const viaCompanion = await localCompanion.file.search(safe, 'needle')
      const direct = await searchFiles(safe, 'needle')
      expect(viaCompanion).toEqual(direct)
      expect(viaCompanion.some((r) => r.name === 'alpha.ts')).toBe(true)
    })
  })

  describe('locator routing', () => {
    test('a bare local path routes to the local companion and reads', async () => {
      // A local workspace path round-trips as a bare string (no scheme).
      const locator = formatLocator({ companionId: LOCAL_COMPANION_ID, path: rootDir })
      expect(locator).toBe(rootDir)
      const safe = await localCompanion.validatePathStrict(locator)
      const tree = await localCompanion.file.readDir(safe)
      expect(tree.map((n) => n.name)).toContain('alpha.ts')
    })
  })
})
