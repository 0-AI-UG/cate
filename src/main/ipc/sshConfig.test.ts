import { describe, expect, test } from 'vitest'
import { parseSshConfig } from './companion'

const HOME = '/home/me'

describe('parseSshConfig', () => {
  test('parses a host block with all fields', () => {
    const cfg = `
Host prod
  HostName 10.0.0.5
  User deploy
  Port 2222
  IdentityFile ~/.ssh/prod_ed25519
`
    expect(parseSshConfig(cfg, HOME)).toEqual([
      { alias: 'prod', host: '10.0.0.5', user: 'deploy', port: 2222, identityFile: '/home/me/.ssh/prod_ed25519' },
    ])
  })

  test('defaults HostName to the alias when unset', () => {
    expect(parseSshConfig('Host box\n  User root\n', HOME)).toEqual([
      { alias: 'box', host: 'box', user: 'root' },
    ])
  })

  test('accepts Key=value and is case-insensitive', () => {
    expect(parseSshConfig('host=web\nhostname=web.example.com\nUSER=ubuntu\n', HOME)).toEqual([
      { alias: 'web', host: 'web.example.com', user: 'ubuntu' },
    ])
  })

  test('drops wildcard patterns but keeps their non-wildcard siblings', () => {
    const cfg = `
Host * !ignored everywhere
  User shared
Host literal
  HostName real.host
`
    expect(parseSshConfig(cfg, HOME)).toEqual([
      { alias: 'everywhere', host: 'everywhere', user: 'shared' },
      { alias: 'literal', host: 'real.host' },
    ])
  })

  test('ignores comments, blank lines, and unknown keys', () => {
    const cfg = `# my hosts\n\nHost a\n  HostName a.example.com\n  ForwardAgent yes\n`
    expect(parseSshConfig(cfg, HOME)).toEqual([{ alias: 'a', host: 'a.example.com' }])
  })

  test('empty config yields no entries', () => {
    expect(parseSshConfig('', HOME)).toEqual([])
  })
})
