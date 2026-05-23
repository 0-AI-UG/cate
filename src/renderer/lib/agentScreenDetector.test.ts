import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { useStatusStore } from '../stores/statusStore'
import {
  computeRawState,
  applyHysteresis,
  RUNNING_HOLD_MS,
  type HysteresisState,
} from './agentScreenDetectorLogic'
import type { AgentState } from '../../shared/types'

const WS = 'ws-1'
const PTY = 'pty-1'

function resetStore(): void {
  useStatusStore.setState({ workspaces: {}, _clearTimers: {}, terminalWorkspaceMap: {}, gitInfo: {} })
}

function setup(agentPresent: boolean, subprocessActive = false): void {
  const s = useStatusStore.getState()
  s.setAgentPresent(WS, PTY, agentPresent)
  s.setSubprocessActive(WS, PTY, subprocessActive)
  if (agentPresent) s.setAgentState(WS, PTY, 'notRunning', 'Claude Code')
}

function tick(wasAgentPresent: boolean, h: HysteresisState, now: number): AgentState {
  const ws = useStatusStore.getState().workspaces[WS]
  const raw = computeRawState({
    agentPresent: ws?.agentPresent[PTY] === true,
    wasAgentPresent,
    subprocessActive: ws?.subprocessActive[PTY] === true,
  })
  const state = applyHysteresis(raw, h, now)
  if (h.lastReported !== state) {
    h.lastReported = state
    useStatusStore.getState().setAgentState(WS, PTY, state, ws?.agentName[PTY] ?? null)
  }
  return state
}

function displayed(): AgentState | undefined {
  return useStatusStore.getState().workspaces[WS]?.agentState[PTY]
}

describe('agent detection', () => {
  beforeEach(() => { resetStore(); useStatusStore.getState().ensureWorkspace(WS); useStatusStore.getState().registerTerminal(PTY, WS) })
  afterEach(resetStore)

  it('idle agent → waitingForInput', () => {
    setup(true)
    const h: HysteresisState = { lastReported: null, pendingWaitingSince: null }
    tick(false, h, 0)
    expect(displayed()).toBe('waitingForInput')
  })

  it('subprocess → running', () => {
    setup(true, true)
    const h: HysteresisState = { lastReported: null, pendingWaitingSince: null }
    tick(false, h, 0)
    expect(displayed()).toBe('running')
  })

  it('subprocess ends → waitingForInput after hold', () => {
    setup(true, true)
    const h: HysteresisState = { lastReported: null, pendingWaitingSince: null }
    tick(false, h, 0)
    expect(displayed()).toBe('running')

    useStatusStore.getState().setSubprocessActive(WS, PTY, false)
    tick(true, h, 100)
    expect(displayed()).toBe('running') // held

    tick(true, h, 100 + RUNNING_HOLD_MS)
    expect(displayed()).toBe('waitingForInput')
  })

  it('agent exits → finished', () => {
    setup(true)
    const h: HysteresisState = { lastReported: null, pendingWaitingSince: null }
    tick(false, h, 0)

    useStatusStore.getState().setAgentPresent(WS, PTY, false)
    tick(true, h, 1000)
    expect(displayed()).toBe('finished')
  })
})
