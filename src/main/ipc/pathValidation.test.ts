import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  addAllowedRoot,
  clearFileGrantsForWindow,
  clearScopedWriteAllowancesForWindow,
  consumeScopedWriteAllowance,
  getAllowedRoots,
  grantFileAccess,
  registerScopedWriteAllowance,
  removeAllowedRoot,
  validatePath,
  validatePathForCreation,
  validatePathStrict,
  pathCompareKey,
} from './pathValidation'

describe('pathValidation', () => {
  let rootDir: string
  let outsideDir: string

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(process.cwd(), 'cate-root-'))
    outsideDir = await fs.mkdtemp(path.join(process.cwd(), 'cate-outside-'))
    addAllowedRoot(rootDir)
  })

  afterEach(async () => {
    for (const root of Array.from(getAllowedRoots())) removeAllowedRoot(root)
    clearScopedWriteAllowancesForWindow(1)
    clearScopedWriteAllowancesForWindow(2)
    clearFileGrantsForWindow(1)
    clearFileGrantsForWindow(2)
    await fs.rm(rootDir, { recursive: true, force: true })
    await fs.rm(outsideDir, { recursive: true, force: true })
    vi.useRealTimers()
  })

  test('allows creation inside trusted roots', async () => {
    const safePath = await validatePathForCreation(path.join(rootDir, 'file.txt'))
    expect(safePath).toContain(path.join(rootDir, 'file.txt'))
  })

  test('allows exactly one scoped write outside trusted roots', async () => {
    const targetPath = path.join(outsideDir, 'export.json')
    const registeredPath = await registerScopedWriteAllowance(1, targetPath)

    await expect(validatePathForCreation(targetPath, 1)).resolves.toBe(registeredPath)

    consumeScopedWriteAllowance(1, registeredPath)

    await expect(validatePathForCreation(targetPath, 1)).rejects.toThrow(/outside allowed directories/)
  })

  test('expires scoped write allowances and clears them on window close', async () => {
    vi.useFakeTimers()
    const targetPath = path.join(outsideDir, 'late.json')
    await registerScopedWriteAllowance(2, targetPath, 10)

    await expect(validatePathForCreation(targetPath, 2)).resolves.toContain('late.json')

    vi.advanceTimersByTime(11)
    await expect(validatePathForCreation(targetPath, 2)).rejects.toThrow(/outside allowed directories/)

    await registerScopedWriteAllowance(2, targetPath, 1_000)
    clearScopedWriteAllowancesForWindow(2)
    await expect(validatePathForCreation(targetPath, 2)).rejects.toThrow(/outside allowed directories/)
  })

  test('grantFileAccess allows reads and repeated writes outside trusted roots', async () => {
    const targetPath = path.join(outsideDir, 'saved.txt')
    await fs.writeFile(targetPath, 'hello')

    // Without a grant the lexical and strict validators both reject.
    expect(() => validatePath(targetPath, 1)).toThrow(/outside allowed directories/)
    await expect(validatePathStrict(targetPath, 1)).rejects.toThrow(/outside allowed directories/)
    await expect(validatePathForCreation(targetPath, 1)).rejects.toThrow(/outside allowed directories/)

    await grantFileAccess(1, targetPath)

    // After granting, all three validators accept the path.
    expect(validatePath(targetPath, 1)).toBe(path.resolve(targetPath))
    await expect(validatePathStrict(targetPath, 1)).resolves.toBe(path.resolve(targetPath))
    await expect(validatePathForCreation(targetPath, 1)).resolves.toBe(path.resolve(targetPath))

    // Grant is not consumed; it survives many uses.
    await expect(validatePathForCreation(targetPath, 1)).resolves.toBe(path.resolve(targetPath))
    await expect(validatePathStrict(targetPath, 1)).resolves.toBe(path.resolve(targetPath))
  })

  test('grantFileAccess is scoped per window and cleared on window close', async () => {
    const targetPath = path.join(outsideDir, 'window-scoped.txt')
    await fs.writeFile(targetPath, 'data')
    await grantFileAccess(1, targetPath)

    // Window 1 sees the grant.
    await expect(validatePathStrict(targetPath, 1)).resolves.toBe(path.resolve(targetPath))
    // Window 2 does not.
    await expect(validatePathStrict(targetPath, 2)).rejects.toThrow(/outside allowed directories/)
    // Untagged calls (no window id) are rejected.
    await expect(validatePathStrict(targetPath)).rejects.toThrow(/outside allowed directories/)

    clearFileGrantsForWindow(1)
    await expect(validatePathStrict(targetPath, 1)).rejects.toThrow(/outside allowed directories/)
  })

  // The root/grant comparison is case-insensitive on win32 (paths there are
  // case-insensitive) and case-sensitive on POSIX. Exercise the pure key helper
  // with an injected platform so the win32 branch is covered cross-platform.
  describe('pathCompareKey (win32 case-insensitivity)', () => {
    test('win32 lowercases so different-cased paths compare equal', () => {
      expect(pathCompareKey('C:\\Users\\Alice\\Repo', 'win32')).toBe(
        pathCompareKey('c:\\users\\alice\\repo', 'win32'),
      )
      expect(pathCompareKey('C:\\Users\\Alice', 'win32')).toBe('c:\\users\\alice')
    })

    test('posix is case-sensitive (paths preserved)', () => {
      expect(pathCompareKey('/Users/Alice/Repo', 'linux')).toBe('/Users/Alice/Repo')
      expect(pathCompareKey('/Users/Alice/Repo', 'linux')).not.toBe(
        pathCompareKey('/users/alice/repo', 'linux'),
      )
      expect(pathCompareKey('/Users/Alice/Repo', 'darwin')).toBe('/Users/Alice/Repo')
    })
  })
})
