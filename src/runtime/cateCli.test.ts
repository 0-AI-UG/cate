// catePathEnv gates on CATE_API and only prepends when the bundled CLI dir
// actually exists (dev/direct mode has no extracted tarball). We can't force the
// tarball layout in a unit test, so we assert the gate behaviour that does not
// depend on the filesystem, plus that a present PATH is preserved when it no-ops.
import { describe, it, expect } from 'vitest'
import { catePathEnv, cateBinDir, cateCliPath } from './cateCli'
import { existsSync } from 'fs'
import path from 'path'

describe('catePathEnv', () => {
  it('no-ops when CATE_API is absent (CLI disabled / not injected)', () => {
    const env = { PATH: '/usr/bin' }
    expect(catePathEnv(env)).toEqual(env)
  })

  it('returns env unchanged (never drops keys) regardless of the tarball state', () => {
    const env = { PATH: '/usr/bin', CATE_API: 'http://127.0.0.1:1', FOO: 'bar' }
    const out = catePathEnv(env)
    expect(out.CATE_API).toBe('http://127.0.0.1:1')
    expect(out.FOO).toBe('bar')
    // PATH is either unchanged (no tarball in this test env) or prefixed with the
    // bin dir — but the original entry must still be present either way.
    expect(out.PATH).toContain('/usr/bin')
  })

  it('prepends cateBinDir() to PATH when the CLI dir exists and CATE_API is set', () => {
    const env = { PATH: '/usr/bin', CATE_API: 'http://127.0.0.1:1' }
    const out = catePathEnv(env)
    if (existsSync(cateBinDir())) {
      expect(out.PATH).toBe(cateBinDir() + path.delimiter + '/usr/bin')
    } else {
      expect(out.PATH).toBe('/usr/bin')
    }
  })

  it('cateBinDir/cateCliPath resolve under a shared install root', () => {
    expect(cateCliPath().startsWith(path.dirname(path.dirname(cateBinDir())))).toBe(true)
    expect(cateBinDir().endsWith(path.join('cate', 'bin'))).toBe(true)
    expect(cateCliPath().endsWith(path.join('cate', 'dist', 'cli.cjs'))).toBe(true)
  })
})
