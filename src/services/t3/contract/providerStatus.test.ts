import { describe, expect, it } from 'vitest'
import { providerStatusFromSnapshot, t3ProviderModelsFromConfig } from '../contract'

describe('providerStatusFromSnapshot', () => {
  it('preserves an authenticated provider label', () => {
    expect(providerStatusFromSnapshot('codex', {
      enabled: true,
      installed: true,
      auth: { status: 'authenticated', label: 'ChatGPT Pro' },
    })).toEqual({ providerId: 'codex', state: 'authenticated', label: 'ChatGPT Pro' })
  })

  it('distinguishes disabled and unauthenticated providers', () => {
    expect(providerStatusFromSnapshot('grok', {
      enabled: false,
      installed: false,
      auth: { status: 'unknown' },
    }).state).toBe('disabled')
    expect(providerStatusFromSnapshot('claude', {
      enabled: true,
      installed: true,
      auth: { status: 'unauthenticated' },
    }).state).toBe('unauthenticated')
  })

  it('treats a ready provider probe as connected and exposes available updates', () => {
    expect(providerStatusFromSnapshot('grok', {
      enabled: true,
      installed: true,
      status: 'ready',
      version: '1.0.13',
      auth: { status: 'unknown' },
      versionAdvisory: {
        status: 'behind_latest',
        latestVersion: '1.0.14',
        canUpdate: true,
        message: 'Install the update.',
      },
    })).toEqual({
      providerId: 'grok',
      state: 'authenticated',
      version: '1.0.13',
      update: {
        latestVersion: '1.0.14',
        canUpdate: true,
        message: 'Install the update.',
      },
    })
  })
})

describe('t3ProviderModelsFromConfig', () => {
  it('lists the known provider instances with their current models, in registry order', () => {
    const config = [
      { instanceId: 'claude-main', driver: 'claudeAgent', displayName: 'Claude', enabled: true, installed: true, status: 'ready', auth: { status: 'authenticated' }, models: [
        { slug: 'opus', name: 'Opus', isDefault: true },
        { slug: 'old', name: 'Old', isLegacy: true },
      ] },
      { instanceId: 'codex', driver: 'codex', enabled: true, installed: false, status: 'error', auth: { status: 'unknown' }, models: [] },
      { instanceId: 'x', driver: 'somethingElse', enabled: true, installed: true, models: [] },
    ]
    expect(t3ProviderModelsFromConfig(config)).toEqual([
      { providerId: 'claude', instanceId: 'claude-main', label: 'Claude', ready: true, models: [{ slug: 'opus', name: 'Opus', isDefault: true }] },
      { providerId: 'codex', instanceId: 'codex', label: 'codex', ready: false, models: [] },
    ])
    expect(t3ProviderModelsFromConfig(undefined)).toEqual([])
  })
})
