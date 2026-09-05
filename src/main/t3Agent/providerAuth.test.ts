import { describe, expect, it } from 'vitest'
import { cleanProviderAuthOutput, providerAuthCode, providerAuthCommand, providerAuthUrl } from './providerAuth'

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
