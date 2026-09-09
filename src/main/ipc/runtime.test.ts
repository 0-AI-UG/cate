import { describe, expect, test, vi } from 'vitest'

vi.mock('../runtime/sshSecretStore', () => ({ getSshSecret: vi.fn(async () => null), saveSshSecret: vi.fn(async () => {}) }))
import { getSshSecret, saveSshSecret } from '../runtime/sshSecretStore'
import { mergedSshSecret, mintRuntimeId, registerRemoteConnection } from './runtime'

describe('mintRuntimeId', () => {
  test('WSL ids carry the sanitized distro name as a readable prefix + a path hash', () => {
    expect(mintRuntimeId({ kind: 'wsl', distro: 'Ubuntu-22.04', distroPath: '/p' })).toMatch(/^wsl_Ubuntu-22\.04_[0-9a-f]{10}$/)
    expect(mintRuntimeId({ kind: 'wsl', distro: 'weird/name space', distroPath: '/p' })).toMatch(/^wsl_weird-name-space_[0-9a-f]{10}$/)
  })

  test('WSL ids are stable for the same distro+path', () => {
    const a = mintRuntimeId({ kind: 'wsl', distro: 'Ubuntu', distroPath: '/home/me/proj' })
    const a2 = mintRuntimeId({ kind: 'wsl', distro: 'Ubuntu', distroPath: '/home/me/proj' })
    expect(a).toBe(a2)
  })

  test('server ids are stable for the same target and differ across targets', () => {
    const a = mintRuntimeId({ kind: 'server', host: 'h', user: 'u', remotePath: '/p' })
    const a2 = mintRuntimeId({ kind: 'server', host: 'h', user: 'u', remotePath: '/p' })
    const b = mintRuntimeId({ kind: 'server', host: 'h2', user: 'u', remotePath: '/p' })
    expect(a).toBe(a2)
    expect(a).not.toBe(b)
    expect(a.startsWith('srv_')).toBe(true)
  })

  test('server port participates in identity', () => {
    const def = mintRuntimeId({ kind: 'server', host: 'h', user: 'u', remotePath: '/p' })
    const alt = mintRuntimeId({ kind: 'server', host: 'h', user: 'u', port: 2222, remotePath: '/p' })
    expect(def).not.toBe(alt)
  })

  // The path is part of the identity for BOTH transports: each daemon sandboxes
  // to a single --root, so two workspaces at different paths must get distinct ids
  // (otherwise the second reuses the first daemon and its path falls outside that
  // daemon's allowed root).
  test('the path participates in identity for both server and WSL ids', () => {
    const srvA = mintRuntimeId({ kind: 'server', host: 'h', user: 'u', remotePath: '/a' })
    const srvB = mintRuntimeId({ kind: 'server', host: 'h', user: 'u', remotePath: '/b' })
    expect(srvA).not.toBe(srvB)

    const wslA = mintRuntimeId({ kind: 'wsl', distro: 'Ubuntu', distroPath: '/home/me/a' })
    const wslB = mintRuntimeId({ kind: 'wsl', distro: 'Ubuntu', distroPath: '/home/me/b' })
    expect(wslA).not.toBe(wslB)
  })
})

describe('mergedSshSecret', () => {
  test('keeps stored key material when edit fields are blank and persists agent=false', () => {
    expect(mergedSshSecret(
      { keyPath: '/keys/id_ecdsa', passphrase: 'secret', useAgent: true },
      { useAgent: false },
    )).toEqual({ keyPath: '/keys/id_ecdsa', passphrase: 'secret', useAgent: false })
  })
})


test('editing a saved target preserves its credentials without exposing them in the profile', async () => {
  vi.mocked(getSshSecret).mockImplementation(async (id) => id === 'previous' ? { keyPath: '/keys/private', passphrase: 'secret', useAgent: false } : null)
  const result = await registerRemoteConnection({ kind: 'server', host: 'new-host', user: 'me', remotePath: '/project', auth: {} }, 'previous')
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error)
  expect(saveSshSecret).toHaveBeenCalledWith(result.runtimeId, { keyPath: '/keys/private', passphrase: 'secret', useAgent: false })
  expect(result.connection).not.toHaveProperty('auth')
  expect(JSON.stringify(result)).not.toContain('secret')
})
