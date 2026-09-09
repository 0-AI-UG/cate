import { describe, expect, test } from 'vitest'
import { buildConnectSpec, parseSshTarget, type RemoteConnectFields } from './RemoteConnect'

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

  test('keeps an SSH config alias without requiring an explicit user', () => {
    const spec = buildConnectSpec('server', { ...base, host: 'corp-bastion', remotePath: '/srv/project' })
    expect(spec).toMatchObject({ kind: 'server', host: 'corp-bastion', user: '' })
  })

  test('builds a WSL spec ignoring server fields', () => {
    const spec = buildConnectSpec('wsl', { ...base, host: 'ignored', distro: ' Ubuntu-22.04 ', distroPath: ' /home/me/proj ' })
    expect(spec).toEqual({ kind: 'wsl', distro: 'Ubuntu-22.04', distroPath: '/home/me/proj' })
  })

  test.each(['~/project', 'home/user/project', 'cwd'])(
    'rejects a relative WSL path (%s)',
    (distroPath) => {
      expect(() => buildConnectSpec('wsl', { ...base, distro: 'Ubuntu', distroPath }))
        .toThrow('Remote workspace path must be an absolute POSIX path')
    },
  )

  test('rejects a relative SSH path', () => {
    expect(() => buildConnectSpec('server', { ...base, host: 'h', user: 'u', remotePath: 'project' }))
      .toThrow('Remote workspace path must be an absolute POSIX path')
  })
})

describe('parseSshTarget', () => {
  test('bare host', () => {
    expect(parseSshTarget('example.com')).toEqual({ user: undefined, host: 'example.com', port: undefined })
  })

  test('user@host', () => {
    expect(parseSshTarget('ubuntu@example.com')).toEqual({ user: 'ubuntu', host: 'example.com', port: undefined })
  })

  test('user@host:port', () => {
    expect(parseSshTarget('ubuntu@example.com:2222')).toEqual({ user: 'ubuntu', host: 'example.com', port: '2222' })
  })

  test('trims surrounding whitespace', () => {
    expect(parseSshTarget('  ubuntu@example.com  ')).toEqual({ user: 'ubuntu', host: 'example.com', port: undefined })
  })

  test('a pasted ssh command with -p before the target', () => {
    expect(parseSshTarget('ssh -p 2222 ubuntu@example.com')).toEqual({ user: 'ubuntu', host: 'example.com', port: '2222' })
  })

  test('a pasted ssh command with the flag after the target', () => {
    expect(parseSshTarget('ssh ubuntu@example.com -p 2022')).toEqual({ user: 'ubuntu', host: 'example.com', port: '2022' })
  })

  test('empty input yields no parts', () => {
    expect(parseSshTarget('   ')).toEqual({})
  })
})

describe('SSH validation regressions', () => {
  test.each(['0', '65536', '-1', '1.5', 'abc'])('rejects invalid port %s', (port) => {
    expect(() => buildConnectSpec('server', { ...base, host: 'host', remotePath: '/project', port })).toThrow('Port must')
  })
  test('preserves bare IPv6 and parses bracketed IPv6 with a port', () => {
    expect(parseSshTarget('user@2001:db8::1')).toEqual({ user: 'user', host: '2001:db8::1', port: undefined })
    expect(parseSshTarget('user@[2001:db8::1]:2222')).toEqual({ user: 'user', host: '2001:db8::1', port: '2222' })
  })
  test('does not treat SSH option arguments as destinations', () => {
    expect(parseSshTarget('ssh -i /private/key user@host')).toEqual({})
    expect(parseSshTarget('ssh -J jump host')).toEqual({})
  })
})
