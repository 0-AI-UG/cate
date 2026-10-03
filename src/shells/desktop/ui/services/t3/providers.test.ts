import { describe, expect, it } from 'vitest'
import { T3_PROVIDER_LOGINS, providerUpdateFeedback } from './providers'

describe('agent provider authentication', () => {
  it('offers every provider supported by the pinned T3 harness', () => {
    expect(T3_PROVIDER_LOGINS.map((provider) => provider.id)).toEqual([
      'claude',
      'codex',
      'cursor',
      'grok',
      'opencode',
    ])
  })
})

describe('provider update feedback', () => {
  it('explains a Homebrew release lag without claiming the update succeeded', () => {
    const result = providerUpdateFeedback({ version: '0.153.2', versionAdvisory: { updateCommand: 'brew upgrade codex' }, updateState: { status: 'unchanged' } })
    expect(result.error).toBe(true)
    expect(result.message).toContain('Homebrew')
    expect(result.message).toContain('0.153.2')
    expect(result.message).not.toContain('T3')
  })
  it('never treats a missing completion state as success', () => {
    expect(providerUpdateFeedback().error).toBe(true)
  })
  it('keeps failed updates as failures and neutralizes product copy', () => {
    expect(providerUpdateFeedback({ updateState: { status: 'failed', message: 'T3Code could not update.' } })).toEqual({ error: true, message: 'T3 Code could not update.' })
  })
  it('reports verified completion', () => {
    expect(providerUpdateFeedback({ updateState: { status: 'succeeded', message: 'Provider updated.' } })).toEqual({ error: false, message: 'Provider updated.' })
  })
})
