import { describe, it, expect } from 'vitest'
import { shouldObserve, OBSERVE_COOLDOWN_MS, MAX_OPEN_SUGGESTIONS, type TriggerGateInput } from './petTriggerGate'

function base(over: Partial<TriggerGateInput> = {}): TriggerGateInput {
  return {
    enabled: true,
    paused: false,
    autoObserve: true,
    dirty: true,
    observerBusy: false,
    executorBusy: false,
    openSuggestions: 0,
    lastObserveAt: 0,
    now: OBSERVE_COOLDOWN_MS + 1,
    ...over,
  }
}

describe('shouldObserve', () => {
  it('fires when dirty, enabled, idle, past cooldown', () => {
    expect(shouldObserve(base())).toBe(true)
  })

  it('holds when disabled or paused', () => {
    expect(shouldObserve(base({ enabled: false }))).toBe(false)
    expect(shouldObserve(base({ paused: true }))).toBe(false)
  })

  it('holds when not dirty', () => {
    expect(shouldObserve(base({ dirty: false }))).toBe(false)
  })

  it('holds when automatic observations are off', () => {
    expect(shouldObserve(base({ autoObserve: false }))).toBe(false)
  })

  it('holds while observer or executor is busy', () => {
    expect(shouldObserve(base({ observerBusy: true }))).toBe(false)
    expect(shouldObserve(base({ executorBusy: true }))).toBe(false)
  })

  it('holds at/above the open-suggestion cap', () => {
    expect(shouldObserve(base({ openSuggestions: MAX_OPEN_SUGGESTIONS }))).toBe(false)
    expect(shouldObserve(base({ openSuggestions: MAX_OPEN_SUGGESTIONS - 1 }))).toBe(true)
  })

  it('respects the cooldown window', () => {
    expect(shouldObserve(base({ lastObserveAt: 0, now: OBSERVE_COOLDOWN_MS - 1 }))).toBe(false)
    expect(shouldObserve(base({ lastObserveAt: 0, now: OBSERVE_COOLDOWN_MS + 1 }))).toBe(true)
  })
})
