import { describe, expect, it } from 'vitest'
import { cleanProviderAuthOutput, providerAuthCode, providerAuthCommand, providerAuthLaunch, providerAuthUrl } from '../contract'

describe('providerAuthCommand', () => {
  it('uses device authentication where the provider supports it', () => {
    expect(providerAuthCommand('codex')).toEqual({
      executable: 'codex',
      args: ['login', '--device-auth'],
    })
    expect(providerAuthCommand('grok').args).toContain('--device-auth')
  })

  it('passes an explicit OpenCode provider without invoking a shell', () => {
    expect(providerAuthCommand('opencode', ' anthropic ')).toEqual({
      executable: 'opencode',
      args: ['auth', 'login', '--provider', 'anthropic'],
    })
  })
})

describe('providerAuthLaunch', () => {
  it('uses the default command when no provider profile exists', () => {
    expect(providerAuthLaunch('claude', null, '/Users/me')).toEqual({
      command: { executable: 'claude', args: ['auth', 'login'] },
      env: {},
    })
  })

  it('uses the configured binary and Claude config directory', () => {
    const profile = { providers: { claudeAgent: { binaryPath: '~/bin/claude', homePath: '~/.claude-work' } } }
    expect(providerAuthLaunch('claude', profile, '/Users/me')).toEqual({
      command: { executable: '/Users/me/bin/claude', args: ['auth', 'login'] },
      env: { CLAUDE_CONFIG_DIR: '/Users/me/.claude-work' },
    })
  })

  it('signs Codex into the shadow home when one is configured', () => {
    expect(providerAuthLaunch('codex', { providers: { codex: { homePath: '/shared' } } }, null).env)
      .toEqual({ CODEX_HOME: '/shared' })
    expect(providerAuthLaunch('codex', { providers: { codex: { homePath: '/shared', shadowHomePath: '/auth' } } }, null).env)
      .toEqual({ CODEX_HOME: '/auth' })
  })

  it('refuses a ~ path it cannot expand (remote runtime) instead of passing it literally', () => {
    // Literal ~ with cwd = checkout would write credentials into ./~/ in the repo.
    expect(() => providerAuthLaunch('codex', { providers: { codex: { shadowHomePath: '~/.codex-auth' } } }, null))
      .toThrow(/~\/\.codex-auth.*absolute path/)
    expect(() => providerAuthLaunch('claude', { providers: { claudeAgent: { homePath: '~' } } }, null)).toThrow(/absolute path/)
    expect(() => providerAuthLaunch('opencode', { providers: { opencode: { binaryPath: '~/bin/opencode' } } }, null)).toThrow(/absolute path/)
    expect(providerAuthLaunch('codex', { providers: { codex: { homePath: '~/.codex' } } }, '/home/me').env)
      .toEqual({ CODEX_HOME: '/home/me/.codex' })
  })

  it('keeps OpenCode provider selection alongside a custom binary', () => {
    expect(providerAuthLaunch('opencode', { providers: { opencode: { binaryPath: '/opt/opencode' } } }, null, 'openai').command)
      .toEqual({ executable: '/opt/opencode', args: ['auth', 'login', '--provider', 'openai'] })
  })
})

describe('provider auth output', () => {
  it('removes terminal control sequences and extracts an HTTPS login URL', () => {
    const output = '\u001b[32mOpen https://auth.example.test/device.\u001b[0m\rCode: ABCD'
    expect(cleanProviderAuthOutput(output)).toBe('Open https://auth.example.test/device.\nCode: ABCD')
    expect(providerAuthUrl(output)).toBe('https://auth.example.test/device')
  })

  it('extracts the one-time device code from provider output', () => {
    expect(providerAuthCode('Enter this one-time code\r\n  UYVW-8U3MS')).toBe('UYVW-8U3MS')
  })
})
