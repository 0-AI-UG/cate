import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import fs from 'fs'
import { resolveShell, isExecutable } from './shellResolver'

// Stub fs.statSync / fs.accessSync so tests don't depend on the host's installed
// shells. Each candidate maps to a state: 'exec', 'noexec', 'missing'.
type State = 'exec' | 'noexec' | 'missing'
function stubFs(map: Record<string, State>) {
  vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike) => {
    const key = String(p)
    const s = map[key]
    if (!s || s === 'missing') {
      const err = new Error(`ENOENT: ${key}`) as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    return { isFile: () => true } as fs.Stats
  }) as typeof fs.statSync)

  vi.spyOn(fs, 'accessSync').mockImplementation(((p: fs.PathLike) => {
    const key = String(p)
    const s = map[key]
    if (s !== 'exec') {
      const err = new Error(`EACCES: ${key}`) as NodeJS.ErrnoException
      err.code = 'EACCES'
      throw err
    }
  }) as typeof fs.accessSync)
}

describe('isExecutable', () => {
  beforeEach(() => {
    stubFs({ '/bin/bash': 'exec', '/bin/zsh': 'missing', '/bin/locked': 'noexec' })
  })

  test('returns true for an executable file', () => {
    expect(isExecutable('/bin/bash')).toBe(true)
  })

  test('returns false for a missing file', () => {
    expect(isExecutable('/bin/zsh')).toBe(false)
  })

  test('returns false for a non-executable file', () => {
    expect(isExecutable('/bin/locked')).toBe(false)
  })

  test('returns false for empty input', () => {
    expect(isExecutable('')).toBe(false)
  })
})

describe('resolveShell', () => {
  const originalPlatform = process.platform
  const originalShell = process.env.SHELL

  function setPlatform(p: NodeJS.Platform) {
    Object.defineProperty(process, 'platform', { value: p, configurable: true })
  }

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    if (originalShell === undefined) delete process.env.SHELL
    else process.env.SHELL = originalShell
  })

  test('uses the requested path when it is executable', () => {
    stubFs({ '/bin/zsh': 'exec' })
    setPlatform('darwin')
    process.env.SHELL = '/bin/zsh'

    const r = resolveShell('/bin/zsh')
    expect(r.path).toBe('/bin/zsh')
    expect(r.fallback).toBe(false)
    expect(r.requested).toBeUndefined()
  })

  test('falls back to platform default when requested path is missing (Linux + /bin/zsh)', () => {
    // Reproduces the issue: Linux user has /bin/zsh in settings but only bash exists.
    stubFs({
      '/bin/zsh': 'missing',
      '/bin/bash': 'exec',
      '/bin/sh': 'exec',
    })
    setPlatform('linux')
    delete process.env.SHELL

    const r = resolveShell('/bin/zsh')
    expect(r.path).toBe('/bin/bash')
    expect(r.fallback).toBe(true)
    expect(r.requested).toBe('/bin/zsh')
    expect(r.reason).toBe('missing')
  })

  test('rejects shells whose basename is not allowlisted', () => {
    stubFs({ '/usr/local/bin/python': 'exec', '/bin/bash': 'exec' })
    setPlatform('linux')
    delete process.env.SHELL

    const r = resolveShell('/usr/local/bin/python')
    expect(r.path).toBe('/bin/bash')
    expect(r.fallback).toBe(true)
    expect(r.reason).toBe('disallowed')
  })

  test('honours $SHELL when no preferred path is supplied', () => {
    stubFs({ '/usr/bin/fish': 'exec', '/bin/bash': 'exec' })
    setPlatform('linux')
    process.env.SHELL = '/usr/bin/fish'

    const r = resolveShell()
    expect(r.path).toBe('/usr/bin/fish')
    expect(r.fallback).toBe(false)
  })

  test('walks the platform fallback chain when nothing earlier matches', () => {
    stubFs({ '/bin/sh': 'exec' })
    setPlatform('linux')
    delete process.env.SHELL

    const r = resolveShell()
    expect(r.path).toBe('/bin/sh')
  })

  test('treats blank string as no preference', () => {
    stubFs({ '/bin/zsh': 'exec' })
    setPlatform('darwin')
    process.env.SHELL = '/bin/zsh'

    const r = resolveShell('   ')
    expect(r.path).toBe('/bin/zsh')
    expect(r.fallback).toBe(false)
  })

  test('throws when no shell is available anywhere', () => {
    stubFs({})
    setPlatform('linux')
    delete process.env.SHELL

    expect(() => resolveShell('/bin/zsh')).toThrow(/No usable shell/)
  })

  test('reports not-executable when the file exists but lacks +x', () => {
    stubFs({
      '/bin/zsh': 'noexec',
      '/bin/bash': 'exec',
    })
    setPlatform('linux')
    delete process.env.SHELL

    const r = resolveShell('/bin/zsh')
    expect(r.path).toBe('/bin/bash')
    expect(r.fallback).toBe(true)
    expect(r.reason).toBe('not-executable')
  })
})
