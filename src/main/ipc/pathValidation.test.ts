import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  addAllowedRoot,
  addAllowedRootForRelatedPath,
  clearFileGrantsForWindow,
  clearScopedWriteAllowancesForWindow,
  consumeScopedWriteAllowance,
  grantFileAccess,
  registerScopedWriteAllowance,
  removeAllowedRoot,
  removeAllowedRootFromAllScopes,
  validatePath,
  validatePathForCreation,
  validatePathStrict,
  pathCompareKey,
} from './pathValidation'

describe('pathValidation', () => {
  const SCOPE = 'ws-a'
  let rootDir: string
  let outsideDir: string

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(process.cwd(), 'cate-root-'))
    outsideDir = await fs.mkdtemp(path.join(process.cwd(), 'cate-outside-'))
    addAllowedRoot(rootDir, SCOPE)
  })

  afterEach(async () => {
    removeAllowedRoot(rootDir, SCOPE)
    clearScopedWriteAllowancesForWindow(1)
    clearScopedWriteAllowancesForWindow(2)
    clearFileGrantsForWindow(1)
    clearFileGrantsForWindow(2)
    await fs.rm(rootDir, { recursive: true, force: true })
    await fs.rm(outsideDir, { recursive: true, force: true })
    vi.useRealTimers()
  })

  test('allows creation inside trusted roots', async () => {
    const safePath = await validatePathForCreation(path.join(rootDir, 'file.txt'), undefined, SCOPE)
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

  // Paths that don't exist yet must validate (not error as "Access denied") so a
  // first-run worktree can list its empty cate-agent sessions dir and mkdir the
  // extensions tree. Resolving the nearest existing ancestor still blocks symlink
  // escapes — the regression that motivated the realpath check in the first place.
  describe('not-yet-created paths', () => {
    test('validatePathStrict resolves a deep missing path under the root (the sessions case)', async () => {
      // Mirrors cate-agent/sessions/<encoded-cwd>: none of these segments exist yet.
      const missing = path.join(rootDir, '.cate', 'cate-agent', 'sessions', '--encoded--')
      await expect(validatePathStrict(missing, undefined, SCOPE)).resolves.toBe(await fs.realpath(rootDir) + missing.slice(rootDir.length))
    })

    test('validatePathForCreation allows a target whose parent chain is missing (the extensions case)', async () => {
      const dest = path.join(rootDir, '.cate', 'cate-agent', 'extensions', 'subagent')
      await expect(validatePathForCreation(dest, undefined, SCOPE)).resolves.toContain(
        path.join('.cate', 'cate-agent', 'extensions', 'subagent'),
      )
    })

    test('still rejects a symlink that escapes the root, even for a missing leaf', async () => {
      // An existing symlink inside the root points outside it; a not-yet-created
      // child under that symlink must resolve through it and be denied.
      const link = path.join(rootDir, 'escape')
      await fs.symlink(outsideDir, link)
      await expect(validatePathStrict(path.join(link, 'new-file.txt'), undefined, SCOPE)).rejects.toThrow(
        /outside allowed directories/,
      )
    })
  })

  describe('per-workspace isolation', () => {
    let scopedRoot: string

    beforeEach(async () => {
      scopedRoot = await fs.mkdtemp(path.join(process.cwd(), 'cate-scoped-'))
      addAllowedRoot(scopedRoot, 'ws-b')
    })

    afterEach(async () => {
      removeAllowedRoot(scopedRoot, 'ws-b')
      await fs.rm(scopedRoot, { recursive: true, force: true })
    })

    test('each scope validates only against its own roots', () => {
      expect(validatePath(path.join(rootDir, 'file.txt'), undefined, SCOPE)).toBe(
        path.resolve(rootDir, 'file.txt'),
      )
      expect(() => validatePath(path.join(scopedRoot, 'file.txt'), undefined, SCOPE)).toThrow(
        /outside allowed directories/,
      )
      expect(validatePath(path.join(scopedRoot, 'file.txt'), undefined, 'ws-b')).toBe(
        path.resolve(scopedRoot, 'file.txt'),
      )
    })

    test('removeAllowedRoot is scoped — wrong scope is a no-op', () => {
      removeAllowedRoot(scopedRoot, 'ws-a') // wrong scope: should not remove
      expect(validatePath(path.join(scopedRoot, 'file.txt'), undefined, 'ws-b')).toBe(
        path.resolve(scopedRoot, 'file.txt'),
      )
    })

    test('denies a workspace access to another workspace root', () => {
      expect(() => validatePath(path.join(rootDir, 'file.txt'), 1, 'ws-b')).toThrow(
        /outside allowed directories/,
      )
    })

    test('denies root-based access when no scope is provided at all', () => {
      expect(() => validatePath(path.join(rootDir, 'file.txt'))).toThrow(
        /outside allowed directories/,
      )
    })

    test('propagates and removes a related worktree root only for owning scopes', async () => {
      const worktree = await fs.mkdtemp(path.join(process.cwd(), 'cate-worktree-'))
      const probe = path.join(worktree, 'file.txt')
      try {
        addAllowedRootForRelatedPath(worktree, rootDir, 'runtime')
        expect(validatePath(probe, undefined, SCOPE)).toBe(path.resolve(probe))
        expect(() => validatePath(probe, undefined, 'ws-b')).toThrow(/outside allowed directories/)
        removeAllowedRootFromAllScopes(worktree)
        expect(() => validatePath(probe, undefined, SCOPE)).toThrow(/outside allowed directories/)
      } finally {
        await fs.rm(worktree, { recursive: true, force: true })
      }
    })
  })

  // Write/creation targets must not be reachable through symlinks: the parent
  // chain is realpath-resolved (a symlinked dir pointing outside the root is
  // rejected), and an EXISTING symlink as the final segment is rejected
  // outright so a write can't follow it out of the validated location.
  describe('symlink write/creation targets', () => {
    test('rejects creation through a symlinked dir inside the root that points outside', async () => {
      const link = path.join(rootDir, 'escape-dir')
      await fs.symlink(outsideDir, link)
      await expect(
        validatePathForCreation(path.join(link, 'new.txt'), undefined, SCOPE),
      ).rejects.toThrow(/outside allowed directories/)
    })

    test('rejects an existing symlink file as the creation target (out-of-root link)', async () => {
      const real = path.join(outsideDir, 'real.txt')
      await fs.writeFile(real, 'data')
      const link = path.join(rootDir, 'link.txt')
      await fs.symlink(real, link)
      await expect(validatePathForCreation(link, undefined, SCOPE)).rejects.toThrow(
        /symbolic link/,
      )
    })

    test('rejects an existing symlink file as the creation target (in-root link)', async () => {
      const real = path.join(rootDir, 'real.txt')
      await fs.writeFile(real, 'data')
      const link = path.join(rootDir, 'link.txt')
      await fs.symlink(real, link)
      await expect(validatePathForCreation(link, undefined, SCOPE)).rejects.toThrow(
        /symbolic link/,
      )
    })

    test('still allows a plain existing file as the creation target', async () => {
      const target = path.join(rootDir, 'plain.txt')
      await fs.writeFile(target, 'old')
      await expect(validatePathForCreation(target, undefined, SCOPE)).resolves.toContain('plain.txt')
    })
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
