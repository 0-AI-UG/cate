// applyLoginEnv: the launcher marker skips the capture (and never leaks to
// children), and a real capture on POSIX merges the login-shell env over
// process.env without dropping anything.

import { afterEach, describe, expect, it } from 'vitest'
import { applyLoginEnv, LOGIN_ENV_MARKER } from './loginEnv'

const posixIt = process.platform === 'win32' ? it.skip : it

const savedShell = process.env.SHELL

afterEach(() => {
  delete process.env[LOGIN_ENV_MARKER]
  if (savedShell === undefined) delete process.env.SHELL
  else process.env.SHELL = savedShell
})

describe('applyLoginEnv', () => {
  it('consumes the launcher marker and skips the capture', async () => {
    process.env[LOGIN_ENV_MARKER] = '1'
    const pathBefore = process.env.PATH
    await applyLoginEnv()
    expect(process.env[LOGIN_ENV_MARKER]).toBeUndefined() // never inherited by children
    expect(process.env.PATH).toBe(pathBefore)
  })

  posixIt('captures the login-shell env and keeps PATH defined', async () => {
    process.env.SHELL = '/bin/sh' // deterministic, always present on POSIX
    await applyLoginEnv()
    expect(process.env.PATH).toBeTruthy()
    expect(process.env[LOGIN_ENV_MARKER]).toBeUndefined()
  }, 15_000)
})
