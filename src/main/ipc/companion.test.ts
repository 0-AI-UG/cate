import { describe, expect, test } from 'vitest'
import { mintCompanionId } from './companion'

describe('mintCompanionId', () => {
  test('WSL ids carry the sanitized distro name as a readable prefix + a path hash', () => {
    expect(mintCompanionId({ kind: 'wsl', distro: 'Ubuntu-22.04', distroPath: '/p' })).toMatch(/^wsl_Ubuntu-22\.04_[0-9a-f]{10}$/)
    expect(mintCompanionId({ kind: 'wsl', distro: 'weird/name space', distroPath: '/p' })).toMatch(/^wsl_weird-name-space_[0-9a-f]{10}$/)
  })

  test('WSL ids are stable for the same distro+path', () => {
    const a = mintCompanionId({ kind: 'wsl', distro: 'Ubuntu', distroPath: '/home/me/proj' })
    const a2 = mintCompanionId({ kind: 'wsl', distro: 'Ubuntu', distroPath: '/home/me/proj' })
    expect(a).toBe(a2)
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

  // The path is part of the identity for BOTH transports: each daemon sandboxes
  // to a single --root, so two workspaces at different paths must get distinct ids
  // (otherwise the second reuses the first daemon and its path falls outside that
  // daemon's allowed root).
  test('the path participates in identity for both server and WSL ids', () => {
    const srvA = mintCompanionId({ kind: 'server', host: 'h', user: 'u', remotePath: '/a' })
    const srvB = mintCompanionId({ kind: 'server', host: 'h', user: 'u', remotePath: '/b' })
    expect(srvA).not.toBe(srvB)

    const wslA = mintCompanionId({ kind: 'wsl', distro: 'Ubuntu', distroPath: '/home/me/a' })
    const wslB = mintCompanionId({ kind: 'wsl', distro: 'Ubuntu', distroPath: '/home/me/b' })
    expect(wslA).not.toBe(wslB)
  })
})
