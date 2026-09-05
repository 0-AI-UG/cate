import { describe, expect, it } from 'vitest'
import {
  applyCateProviderDefaults,
  applyProviderProfile,
  extractProviderProfile,
  isProviderSecretFile,
} from './providerProfile'

describe('T3 provider profile', () => {
  it('copies only provider-owned settings and always enforces local threads', () => {
    const profile = extractProviderProfile({
      providers: { codex: { binaryPath: '/bin/codex' } },
      providerInstances: { work: { driver: 'codex' } },
      backgroundActivity: { overrides: { providerHealthRefreshInterval: 0 } },
      defaultTheme: 'dark',
      defaultThreadEnvMode: 'worktree',
    })
    expect(profile).toEqual({
      providers: { codex: { binaryPath: '/bin/codex' } },
      providerInstances: { work: { driver: 'codex' } },
      backgroundActivity: { overrides: { providerHealthRefreshInterval: 0 } },
    })

    expect(applyProviderProfile({ defaultTheme: 'light', providers: { old: true } }, profile)).toEqual({
      defaultTheme: 'light',
      providers: { codex: { binaryPath: '/bin/codex' } },
      providerInstances: { work: { driver: 'codex' } },
      backgroundActivity: { overrides: { providerHealthRefreshInterval: 0 } },
      defaultThreadEnvMode: 'local',
      enableAgentBrowserAccess: false,
    })
  })

  it('removes stale provider values when the sparse global profile resets them', () => {
    expect(applyProviderProfile({ providers: { codex: {} }, providerInstances: { work: {} } }, {})).toEqual({
      defaultThreadEnvMode: 'local',
      enableAgentBrowserAccess: false,
    })
  })

  it('preserves explicit provider choices', () => {
    expect(applyCateProviderDefaults({
      providers: {
        codex: { binaryPath: '/bin/codex' },
        grok: { enabled: false, binaryPath: '/bin/grok' },
      },
    })).toEqual({
      providers: {
        codex: { enabled: true, binaryPath: '/bin/codex' },
        claudeAgent: { enabled: true },
        cursor: { enabled: true },
        grok: { enabled: false, binaryPath: '/bin/grok' },
        opencode: { enabled: true },
      },
    })
  })

  it('allows only provider environment and usage-source secret files', () => {
    expect(isProviderSecretFile('provider-env-d29yaw-VE9LRU4.bin')).toBe(true)
    expect(isProviderSecretFile('usage-limit-source-example.bin')).toBe(true)
    expect(isProviderSecretFile('desktop-bootstrap-token.bin')).toBe(false)
    expect(isProviderSecretFile('provider-env-example.txt')).toBe(false)
  })

  it('makes Grok opt-in and preserves subsequent explicit enablement', () => {
    const defaults = applyCateProviderDefaults({})
    expect(defaults.providers).toMatchObject({ grok: { enabled: false }, codex: { enabled: true } })
    expect(applyCateProviderDefaults({ providers: { grok: { enabled: true } } }).providers)
      .toMatchObject({ grok: { enabled: true } })
  })
})
