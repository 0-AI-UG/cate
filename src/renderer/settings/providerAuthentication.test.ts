import { describe, expect, it } from 'vitest'
import { AGENT_PROVIDER_LOGINS } from './providerAuthentication'

describe('agent provider authentication', () => {
  it('offers every provider supported by the pinned T3 harness', () => {
    expect(AGENT_PROVIDER_LOGINS.map((provider) => provider.id)).toEqual([
      'codex',
      'claude',
      'cursor',
      'grok',
      'opencode',
    ])
  })
})
