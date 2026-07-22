import { describe, it, expect } from 'vitest'
import { shouldObserve, MAX_OPEN_SUGGESTIONS, type TriggerGateInput } from './cateAgentTriggerGate'

const COOLDOWN_MS = 60_000

function base(over: Partial<TriggerGateInput> = {}): TriggerGateInput {
  return {
    autoObserve: true,
    dirty: true,
    observerBusy: false,
    orchestratorBusy: false,
    openSuggestions: 0,
    lastObserveAt: 0,
    now: COOLDOWN_MS + 1,
    cooldownMs: COOLDOWN_MS,
    ...over,
  }
}

describe('shouldObserve', () => {
  it('fires when dirty, idle, past cooldown', () => {
    expect(shouldObserve(base())).toBe(true)
  })

  it('holds when not dirty', () => {
    expect(shouldObserve(base({ dirty: false }))).toBe(false)
  })

  it('holds when automatic observations are off', () => {
    expect(shouldObserve(base({ autoObserve: false }))).toBe(false)
  })

  it('holds while observer or orchestrator is busy', () => {
    expect(shouldObserve(base({ observerBusy: true }))).toBe(false)
    expect(shouldObserve(base({ orchestratorBusy: true }))).toBe(false)
  })

  it('holds at/above the open-suggestion cap', () => {
    expect(shouldObserve(base({ openSuggestions: MAX_OPEN_SUGGESTIONS }))).toBe(false)
    expect(shouldObserve(base({ openSuggestions: MAX_OPEN_SUGGESTIONS - 1 }))).toBe(true)
  })

  it('respects the cooldown window', () => {
    expect(shouldObserve(base({ lastObserveAt: 0, now: COOLDOWN_MS - 1 }))).toBe(false)
    expect(shouldObserve(base({ lastObserveAt: 0, now: COOLDOWN_MS + 1 }))).toBe(true)
  })

  it('honors a longer configured cooldown', () => {
    expect(shouldObserve(base({ cooldownMs: 5 * COOLDOWN_MS, now: COOLDOWN_MS + 1 }))).toBe(false)
    expect(shouldObserve(base({ cooldownMs: 5 * COOLDOWN_MS, now: 5 * COOLDOWN_MS + 1 }))).toBe(true)
  })
})
