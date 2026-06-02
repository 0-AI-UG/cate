import { describe, expect, test } from 'vitest'
import { buildConnectSpec, type RemoteConnectFields } from './RemoteConnect'

const base: RemoteConnectFields = {
  host: '', user: '', port: '', remotePath: '',
  keyPath: '', passphrase: '', useAgent: true,
  distro: '', distroPath: '',
}

describe('buildConnectSpec', () => {
  test('builds an SSH server spec, trimming and parsing the port', () => {
    const spec = buildConnectSpec('server', {
      ...base,
      host: '  example.com ',
      user: ' ubuntu ',
      port: ' 2222 ',
      remotePath: ' /home/ubuntu/proj ',
      keyPath: ' ~/.ssh/id_ed25519 ',
      passphrase: 'hunter2',
      useAgent: true,
    })
    expect(spec).toEqual({
      kind: 'server',
      host: 'example.com',
      user: 'ubuntu',
      port: 2222,
      remotePath: '/home/ubuntu/proj',
      auth: { keyPath: '~/.ssh/id_ed25519', passphrase: 'hunter2', useAgent: true },
    })
  })

  test('omits an empty port (defaults to 22 downstream) and empty optional auth', () => {
    const spec = buildConnectSpec('server', { ...base, host: 'h', user: 'u', remotePath: '/p' })
    expect(spec).toMatchObject({ kind: 'server', port: undefined })
    if (spec.kind === 'server') {
      expect(spec.auth?.keyPath).toBeUndefined()
      expect(spec.auth?.passphrase).toBeUndefined()
    }
  })

  test('builds a WSL spec ignoring server fields', () => {
    const spec = buildConnectSpec('wsl', { ...base, host: 'ignored', distro: ' Ubuntu-22.04 ', distroPath: ' /home/me/proj ' })
    expect(spec).toEqual({ kind: 'wsl', distro: 'Ubuntu-22.04', distroPath: '/home/me/proj' })
  })
})
