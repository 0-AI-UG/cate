import { afterEach, describe, expect, it } from 'vitest'
import { applyLoginEnv, LOGIN_ENV_MARKER, parseEnvZ, sanitizeEnv } from './loginEnv'

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
    expect(process.env[LOGIN_ENV_MARKER]).toBeUndefined()
    expect(process.env.PATH).toBe(pathBefore)
  })

  posixIt('captures the login-shell env and keeps PATH defined', async () => {
    process.env.SHELL = '/bin/sh'
    await applyLoginEnv()
    expect(process.env.PATH).toBeTruthy()
    expect(process.env[LOGIN_ENV_MARKER]).toBeUndefined()
  }, 15_000)
})

describe('env helpers', () => {
  it('parses NUL-delimited env output, values may hold = and newlines', () => {
    expect(parseEnvZ('A=1\0B=x=y\0C=line\nnext\0')).toEqual({ A: '1', B: 'x=y', C: 'line\nnext' })
    expect(parseEnvZ('')).toBeNull()
  })

  it('drops Electron and npm lifecycle variables', () => {
    expect(sanitizeEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', npm_lifecycle_event: 'dev', X: undefined }))
      .toEqual({ PATH: '/bin' })
  })
})
