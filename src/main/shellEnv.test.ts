import { describe, it, expect, beforeEach, vi } from 'vitest'

// resolveShell is pulled in by shellEnv; stub it so the module loads without
// touching the real shell resolver.
vi.mock('./shellResolver', () => ({
  resolveShell: () => ({ path: '/bin/zsh', fellBack: false }),
}))
vi.mock('./logger', () => ({
  default: { debug() {}, info() {}, warn() {}, error() {} },
}))

import { getShellEnv } from './shellEnv'

describe('getShellEnv sanitization', () => {
  beforeEach(() => {
    // Before resolution, getShellEnv falls back to process.env — exercise the
    // scrub on a controlled set of vars.
    process.env.ELECTRON_RUN_AS_NODE = '1'
    process.env.ELECTRON_NO_ATTACH_CONSOLE = '1'
    process.env.npm_config_cache = '/tmp/npm'
    process.env.npm_lifecycle_event = 'dev'
    process.env.PATH = '/usr/bin:/bin'
  })

  it('strips ELECTRON_* so a child electron-vite dev boots as Electron, not Node', () => {
    const env = getShellEnv()
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(env.ELECTRON_NO_ATTACH_CONSOLE).toBeUndefined()
  })

  it('strips npm_* lifecycle vars from the parent npm run', () => {
    const env = getShellEnv()
    expect(env.npm_config_cache).toBeUndefined()
    expect(env.npm_lifecycle_event).toBeUndefined()
  })

  it('preserves ordinary vars like PATH', () => {
    const env = getShellEnv()
    expect(env.PATH).toBe('/usr/bin:/bin')
  })
})
