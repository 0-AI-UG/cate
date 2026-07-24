import { describe, expect, it } from 'vitest'
import { resolveEffectiveAgentModel } from './agentModels'

const available = [
  { provider: 'anthropic', model: 'claude' },
  { provider: 'openai', model: 'gpt' },
]

describe('resolveEffectiveAgentModel', () => {
  it('keeps an explicit per-chat choice strict even outside the live catalog', () => {
    expect(resolveEffectiveAgentModel(
      { provider: 'custom', model: 'private-model' },
      available[0],
      available,
    )).toEqual({ provider: 'custom', model: 'private-model' })
  })

  it('uses a configured default only while it remains available', () => {
    expect(resolveEffectiveAgentModel(undefined, available[1], available)).toEqual(available[1])
    expect(resolveEffectiveAgentModel(
      undefined,
      { provider: 'removed', model: 'stale' },
      available,
    )).toEqual(available[0])
  })

  it('returns null when neither a strict choice nor an available model exists', () => {
    expect(resolveEffectiveAgentModel(undefined, available[0], [])).toBeNull()
  })
})
