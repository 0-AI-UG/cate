// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import {
  resolveAgentState,
  startAgentScreenDetector,
  stopAgentScreenDetector,
  noteAgentPresence,
  noteAgentHookEvent,
  forgetAgentTracker,
} from './agentScreenDetector'
import { sendOsNotification } from '../notifications/osNotificationSend'
import { useStatusStore, setTerminalWorkspaceResolver } from '../../stores/statusStore'
import type { AgentHookEvent, AgentHookEventKind } from '../../../shared/agentHooks'
import type { AgentId } from '../../../shared/agents'

// Mock the notification sender so the coordinator's import graph stays light
// (the real module pulls settingsStore → logger, which starts a flush interval
// that keeps vitest from exiting). Tests assert calls on the mock.
vi.mock('../notifications/osNotificationSend', () => ({ sendOsNotification: vi.fn() }))

describe('resolveAgentState', () => {
  it('not present, never was → notRunning', () => {
    expect(resolveAgentState({ present: false, wasPresent: false, active: false })).toBe('notRunning')
  })

  it('disappeared after being present → finished', () => {
    expect(resolveAgentState({ present: false, wasPresent: true, active: false })).toBe('finished')
  })

  it('present + active turn → running', () => {
    expect(resolveAgentState({ present: true, wasPresent: true, active: true })).toBe('running')
  })

  it('present + idle → waitingForInput', () => {
    expect(resolveAgentState({ present: true, wasPresent: true, active: false })).toBe('waitingForInput')
  })

  it('activity is ignored when the agent is gone', () => {
    expect(resolveAgentState({ present: false, wasPresent: false, active: true })).toBe('notRunning')
  })
})

// ---------------------------------------------------------------------------
// Coordinator suite — shared per-terminal harness
// ---------------------------------------------------------------------------

const WS = 'ws-1'
const PTY = 'pty-1'

function setUpCoordinator(agentName: string): void {
  vi.mocked(sendOsNotification).mockClear()
  useStatusStore.setState({ workspaces: {} })
  // terminal->workspace identity is owned by terminalRegistry's bimap; stub
  // the resolver so the detector can map this pty to its workspace.
  setTerminalWorkspaceResolver((ptyId) => (ptyId === PTY ? WS : undefined))
  useStatusStore.getState().ensureWorkspace(WS)
  useStatusStore.getState().registerTerminal(PTY, WS)
  // agentName is owned by statusStore; the coordinator reads it at commit time.
  useStatusStore.getState().setAgentName(WS, PTY, agentName)
  startAgentScreenDetector()
}

function state(): string | undefined {
  return useStatusStore.getState().workspaces[WS]?.terminals[PTY]?.agentState
}

function hookEvent(
  kind: AgentHookEventKind,
  agentId: AgentId = 'claude-code',
  raw: Record<string, unknown> = {},
): AgentHookEvent {
  return { terminalId: PTY, agentId, kind, sessionId: 'session-1', raw }
}

describe('agent activity coordinator (hook FSM + presence edges)', () => {
  beforeEach(() => setUpCoordinator('Claude Code'))
  afterEach(stopAgentScreenDetector)

  it('turn-start → running immediately; turn-end → waitingForInput + notification', () => {
    noteAgentPresence(PTY, true)
    expect(state()).toBe('waitingForInput')

    noteAgentHookEvent(hookEvent('turn-start'))
    expect(state()).toBe('running')

    noteAgentHookEvent(hookEvent('turn-end'))
    // Authoritative event: flips immediately, no settle window.
    expect(state()).toBe('waitingForInput')
    expect(sendOsNotification).toHaveBeenCalledTimes(1)
    expect(sendOsNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Claude Code needs input' }),
    )
  })

  it('presence without turn events shows waitingForInput and never notifies', () => {
    // Presence is hook-anchored daemon-side (the agent's first post registers
    // its pid), so present-with-no-TURN-events is a registered agent between
    // prompts: parked on waitingForInput — no false running, no notifications.
    noteAgentPresence(PTY, true)
    expect(state()).toBe('waitingForInput')
    noteAgentPresence(PTY, true) // more 1 Hz scan ticks
    expect(state()).toBe('waitingForInput')
    expect(sendOsNotification).not.toHaveBeenCalled()

    // The scan's falling edge still resolves its end honestly.
    noteAgentPresence(PTY, false)
    expect(state()).toBe('finished')
  })

  it('session-end acts like turn-end for state but stays silent', () => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent(hookEvent('turn-start'))
    expect(state()).toBe('running')

    noteAgentHookEvent(hookEvent('session-end')) // e.g. /clear mid-turn
    expect(state()).toBe('waitingForInput')
    expect(sendOsNotification).not.toHaveBeenCalled()
  })

  it('session-start resets to idle silently', () => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent(hookEvent('turn-start'))
    noteAgentHookEvent(hookEvent('session-start'))
    expect(state()).toBe('waitingForInput')
    expect(sendOsNotification).not.toHaveBeenCalled()
  })

  it('permission-wait mid-turn → waitingForInput + "needs permission" notification', () => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent(hookEvent('turn-start'))
    expect(state()).toBe('running')

    noteAgentHookEvent(hookEvent('permission-wait', 'claude-code', { message: 'Claude needs your permission' }))
    expect(state()).toBe('waitingForInput')
    expect(sendOsNotification).toHaveBeenCalledTimes(1)
    expect(sendOsNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Claude Code needs permission',
        body: 'Claude needs your permission',
      }),
    )
  })

  it('permission notification body comes from the per-CLI payload', () => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent(hookEvent('turn-start'))
    noteAgentHookEvent(
      hookEvent('permission-wait', 'codex', { tool_name: 'Bash', tool_input: { command: 'touch x' } }),
    )
    expect(sendOsNotification).toHaveBeenCalledWith(expect.objectContaining({ body: 'touch x' }))

    noteAgentHookEvent(hookEvent('turn-resume', 'codex'))
    noteAgentHookEvent(hookEvent('permission-wait', 'opencode', { metadata: { command: 'rm -rf ./dist' } }))
    expect(sendOsNotification).toHaveBeenLastCalledWith(expect.objectContaining({ body: 'rm -rf ./dist' }))

    // Missing detail falls back to a generic line rather than an empty body.
    noteAgentHookEvent(hookEvent('turn-resume', 'opencode'))
    noteAgentHookEvent(hookEvent('permission-wait', 'opencode', {}))
    expect(sendOsNotification).toHaveBeenLastCalledWith(
      expect.objectContaining({ body: 'Waiting for your approval.' }),
    )
  })

  it('turn-resume flips back to running silently; ask → resume → ask notifies per ask', () => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent(hookEvent('turn-start'))
    noteAgentHookEvent(hookEvent('permission-wait'))
    expect(state()).toBe('waitingForInput')
    expect(sendOsNotification).toHaveBeenCalledTimes(1)

    noteAgentHookEvent(hookEvent('turn-resume'))
    expect(state()).toBe('running')
    expect(sendOsNotification).toHaveBeenCalledTimes(1) // resume is silent

    noteAgentHookEvent(hookEvent('permission-wait'))
    expect(state()).toBe('waitingForInput')
    expect(sendOsNotification).toHaveBeenCalledTimes(2) // a NEW approval is due
  })

  it('repeated permission-wait without a resume does not re-notify', () => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent(hookEvent('turn-start'))
    noteAgentHookEvent(hookEvent('permission-wait'))
    noteAgentHookEvent(hookEvent('permission-wait'))
    expect(sendOsNotification).toHaveBeenCalledTimes(1)
  })

  it('turn-end after a denied permission does not double-notify', () => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent(hookEvent('turn-start'))
    noteAgentHookEvent(hookEvent('permission-wait'))
    expect(sendOsNotification).toHaveBeenCalledTimes(1)

    // Denial produces no turn-resume — the turn just ends. State is already
    // waitingForInput, so the transition gate swallows the second ping.
    noteAgentHookEvent(hookEvent('turn-end'))
    expect(state()).toBe('waitingForInput')
    expect(sendOsNotification).toHaveBeenCalledTimes(1)
  })

  it('the 1 Hz presence tick cannot flip a blocked turn back to running', () => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent(hookEvent('turn-start'))
    noteAgentHookEvent(hookEvent('permission-wait'))
    expect(state()).toBe('waitingForInput')

    noteAgentPresence(PTY, true) // next scan tick while still blocked
    expect(state()).toBe('waitingForInput')
    expect(sendOsNotification).toHaveBeenCalledTimes(1)
  })

  it('presence loss mid-turn → finished, and the turn state dies with the process', () => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent(hookEvent('turn-start'))
    expect(state()).toBe('running')

    noteAgentPresence(PTY, false)
    expect(state()).toBe('finished')
    // A relaunch must start idle, not resurrect the dead turn.
    noteAgentPresence(PTY, true)
    expect(state()).toBe('waitingForInput')
  })

  it('hook events arriving before the 1 Hz presence scan do not flip state early', () => {
    noteAgentHookEvent(hookEvent('session-start'))
    noteAgentHookEvent(hookEvent('turn-start'))
    expect(state()).toBe('notRunning') // presence is authoritative for existence

    noteAgentPresence(PTY, true)
    expect(state()).toBe('running') // the pending turn surfaces with presence
  })

  it('forgetAgentTracker drops the FSM memory — a re-registered terminal starts fresh', () => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent(hookEvent('turn-start'))
    expect(state()).toBe('running')

    forgetAgentTracker(PTY)
    // Same pty id reused: the in-flight turn is gone — presence alone reads
    // idle, and the fresh-launch flip stays silent.
    noteAgentPresence(PTY, true)
    expect(state()).toBe('waitingForInput')
    expect(sendOsNotification).not.toHaveBeenCalled()
  })

  it('stopAgentScreenDetector halts state changes and clears trackers', () => {
    noteAgentPresence(PTY, true)
    expect(state()).toBe('waitingForInput')

    stopAgentScreenDetector()
    noteAgentHookEvent(hookEvent('turn-start'))
    noteAgentPresence(PTY, true)
    expect(state()).toBe('waitingForInput') // store untouched after stop
    expect(sendOsNotification).not.toHaveBeenCalled()
  })
})
