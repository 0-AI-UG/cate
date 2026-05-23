import { describe, expect, it } from 'vitest'
import {
  computeRawState,
  applyHysteresis,
  RUNNING_HOLD_MS,
  type HysteresisState,
  type DetectorSignals,
} from '../../renderer/lib/agentScreenDetectorLogic'

function signals(overrides: Partial<DetectorSignals> = {}): DetectorSignals {
  return { agentPresent: true, wasAgentPresent: true, subprocessActive: false, ...overrides }
}

describe('computeRawState', () => {
  it('not present, never was → notRunning', () => {
    expect(computeRawState(signals({ agentPresent: false, wasAgentPresent: false }))).toBe('notRunning')
  })

  it('disappeared → finished', () => {
    expect(computeRawState(signals({ agentPresent: false, wasAgentPresent: true }))).toBe('finished')
  })

  it('subprocess active → running', () => {
    expect(computeRawState(signals({ subprocessActive: true }))).toBe('running')
  })

  it('present, no subprocess → waitingForInput', () => {
    expect(computeRawState(signals())).toBe('waitingForInput')
  })
})

describe('applyHysteresis', () => {
  it('running → waitingForInput holds for RUNNING_HOLD_MS', () => {
    const h: HysteresisState = { lastReported: 'running', pendingWaitingSince: null }
    expect(applyHysteresis('waitingForInput', h, 1000)).toBe('running')
    expect(applyHysteresis('waitingForInput', h, 1000 + RUNNING_HOLD_MS - 1)).toBe('running')
    expect(applyHysteresis('waitingForInput', h, 1000 + RUNNING_HOLD_MS)).toBe('waitingForInput')
  })

  it('finished passes through immediately', () => {
    const h: HysteresisState = { lastReported: 'running', pendingWaitingSince: null }
    expect(applyHysteresis('finished', h, 1000)).toBe('finished')
  })

  it('running resets hold timer', () => {
    const h: HysteresisState = { lastReported: 'running', pendingWaitingSince: null }
    applyHysteresis('waitingForInput', h, 1000)
    expect(h.pendingWaitingSince).toBe(1000)
    applyHysteresis('running', h, 1500)
    expect(h.pendingWaitingSince).toBeNull()
  })
})

describe('lifecycle', () => {
  it('notRunning → waiting → running → waiting → finished', () => {
    const states: string[] = []
    const h: HysteresisState = { lastReported: null, pendingWaitingSince: null }

    let s = applyHysteresis(computeRawState(signals()), h, 0)
    h.lastReported = s; states.push(s)

    s = applyHysteresis(computeRawState(signals({ subprocessActive: true })), h, 100)
    h.lastReported = s; states.push(s)

    s = applyHysteresis(computeRawState(signals({ subprocessActive: false })), h, 200)
    h.lastReported = s; states.push(s) // held by hysteresis

    s = applyHysteresis(computeRawState(signals({ subprocessActive: false })), h, 200 + RUNNING_HOLD_MS)
    h.lastReported = s; states.push(s)

    s = applyHysteresis(computeRawState(signals({ agentPresent: false, wasAgentPresent: true })), h, 200 + RUNNING_HOLD_MS + 1000)
    h.lastReported = s; states.push(s)

    expect(states).toEqual(['waitingForInput', 'running', 'running', 'waitingForInput', 'finished'])
  })
})
