import { describe, expect, test } from 'vitest'
import { mintCompanionId } from './companion'

describe('mintCompanionId', () => {
  test('WSL ids are derived from the (sanitized) distro name', () => {
    expect(mintCompanionId({ kind: 'wsl', distro: 'Ubuntu-22.04', distroPath: '/p' })).toBe('wsl_Ubuntu-22.04')
    expect(mintCompanionId({ kind: 'wsl', distro: 'weird/name space', distroPath: '/p' })).toBe('wsl_weird-name-space')
  })

  test('server ids are stable for the same target and differ across targets', () => {
    const a = mintCompanionId({ kind: 'server', host: 'h', user: 'u', remotePath: '/p' })
    const a2 = mintCompanionId({ kind: 'server', host: 'h', user: 'u', remotePath: '/p' })
    const b = mintCompanionId({ kind: 'server', host: 'h2', user: 'u', remotePath: '/p' })
    expect(a).toBe(a2)
    expect(a).not.toBe(b)
    expect(a.startsWith('srv_')).toBe(true)
  })

  test('server port participates in identity', () => {
    const def = mintCompanionId({ kind: 'server', host: 'h', user: 'u', remotePath: '/p' })
    const alt = mintCompanionId({ kind: 'server', host: 'h', user: 'u', port: 2222, remotePath: '/p' })
    expect(def).not.toBe(alt)
  })
})
