// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { resolveAgentState, WAITING_SETTLE_MS, BODY_SPINNER_TIMEOUT_MS } from './agentScreenDetectorLogic'
import { titleIndicatesRunning, outputShowsBodySpinner } from './agentSpinner'
import {
  startAgentScreenDetector,
  stopAgentScreenDetector,
  noteAgentTitle,
  noteAgentPresence,
  noteAgentSpinnerByte,
  noteAgentHookEvent,
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

describe('outputShowsBodySpinner (fallback body spinner)', () => {
  it('detects a body braille spinner frame', () => {
    expect(outputShowsBodySpinner(' ⠋ Working...')).toBe(true)
    expect(outputShowsBodySpinner('\x1b[33m ⠙ Working…\x1b[0m')).toBe(true)
  })

  it('ignores braille inside an OSC title (title spinners stay title-driven)', () => {
    expect(outputShowsBodySpinner('\x1b]0;⠂ Respond with pong\x07')).toBe(false)
    expect(outputShowsBodySpinner('\x1b]0;⠙ cate\x07')).toBe(false)
  })

  it('ignores plain output and block-drawing UI', () => {
    expect(outputShowsBodySpinner('hello world\r\n$ ')).toBe(false)
    expect(outputShowsBodySpinner('█▀▀█ █▀▀█ █▀▀█  ┃ OpenCode ┃')).toBe(false)
    expect(outputShowsBodySpinner('')).toBe(false)
  })
})

describe('titleIndicatesRunning (braille title-spinner classification)', () => {
  // Frames decoded from the bell/title experiment against live agent CLIs.
  it('static idle markers → not running', () => {
    expect(titleIndicatesRunning('✳ Claude Code')).toBe(false)
    expect(titleIndicatesRunning('✱ Test schroejahr.de aufrufen')).toBe(false)
    expect(titleIndicatesRunning('cate')).toBe(false)
  })

  it('braille spinner frames → running', () => {
    for (const frame of ['⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏', '⠋']) {
      expect(titleIndicatesRunning(`${frame} cate`)).toBe(true)
    }
    expect(titleIndicatesRunning('⠂ Respond with pong message')).toBe(true)
  })

  it('blank-braille frame (U+2800) still counts as a spinner', () => {
    expect(titleIndicatesRunning('⠀ cate')).toBe(true)
  })

  it('empty / plain titles → not running', () => {
    expect(titleIndicatesRunning('')).toBe(false)
    expect(titleIndicatesRunning('   ')).toBe(false)
    expect(titleIndicatesRunning('zsh')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Coordinator suites — shared per-terminal harness
// ---------------------------------------------------------------------------

const WS = 'ws-1'
const PTY = 'pty-1'

function setUpCoordinator(agentName: string): void {
  vi.useFakeTimers()
  vi.mocked(sendOsNotification).mockClear()
  useStatusStore.setState({ workspaces: {} })
  // terminal->workspace identity is owned by terminalRegistry's bimap; stub
  // the resolver so the detector can map this pty to its workspace.
  setTerminalWorkspaceResolver((ptyId) => (ptyId === PTY ? WS : undefined))
  useStatusStore.getState().ensureWorkspace(WS)
  useStatusStore.getState().registerTerminal(PTY, WS)
  // agentName is owned by statusStore; the coordinator derives the agent id
  // (hook/fallback routing) and the display name from it.
  useStatusStore.getState().setAgentName(WS, PTY, agentName)
  startAgentScreenDetector()
}

function tearDownCoordinator(): void {
  stopAgentScreenDetector()
  vi.useRealTimers()
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

describe('hook-driven agents (claude/codex/pi/opencode)', () => {
  beforeEach(() => setUpCoordinator('Claude Code'))
  afterEach(tearDownCoordinator)

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

  it('fresh-launch idle (present, no hook events yet) does not notify', () => {
    noteAgentPresence(PTY, true)
    expect(state()).toBe('waitingForInput')
    vi.advanceTimersByTime(WAITING_SETTLE_MS * 2)
    expect(sendOsNotification).not.toHaveBeenCalled()
  })

  it('after the first hook event, spinner inputs are ignored — a stray braille glyph cannot flip state', () => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent(hookEvent('session-start')) // injection proven
    // `cat`ed output containing braille / a title spinner frame:
    noteAgentSpinnerByte(PTY)
    noteAgentTitle(PTY, true)
    expect(state()).toBe('waitingForInput')

    // And the reverse: an idle title while a hook turn is in flight must not
    // arm the settle path or flip the state back.
    noteAgentHookEvent(hookEvent('turn-start'))
    noteAgentTitle(PTY, false)
    vi.advanceTimersByTime(WAITING_SETTLE_MS * 2)
    expect(state()).toBe('running')
    expect(sendOsNotification).not.toHaveBeenCalled()
  })

  it('bypassed injection (no hook events ever) keeps the spinner fallback working', () => {
    // Regression: claude launched via an alias/absolute path — or with the
    // PATH shim shadowed by an rc-file prepend — never fires hook events. The
    // agent must NOT sit on waitingForInput through every turn; the spinner
    // fallback owns state until hooks actually speak.
    noteAgentPresence(PTY, true)
    expect(state()).toBe('waitingForInput')

    noteAgentTitle(PTY, true) // turn running, spinner in the OSC title
    expect(state()).toBe('running')

    noteAgentTitle(PTY, false) // turn ended → settle → notify
    vi.advanceTimersByTime(WAITING_SETTLE_MS)
    expect(state()).toBe('waitingForInput')
    expect(sendOsNotification).toHaveBeenCalledTimes(1)
  })

  it('the first hook event takes over from the spinner path mid-flight', () => {
    noteAgentPresence(PTY, true)
    noteAgentTitle(PTY, true) // spinner-driven running (injection unproven)
    expect(state()).toBe('running')

    noteAgentHookEvent(hookEvent('turn-start')) // hooks speak → they own state
    expect(state()).toBe('running')
    noteAgentTitle(PTY, false) // spinner input now ignored
    vi.advanceTimersByTime(WAITING_SETTLE_MS * 2)
    expect(state()).toBe('running')

    noteAgentHookEvent(hookEvent('turn-end'))
    expect(state()).toBe('waitingForInput')
  })

  it('the hookDriven latch resets on exit — a bypassed relaunch falls back to spinners', () => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent(hookEvent('turn-start'))
    noteAgentHookEvent(hookEvent('turn-end'))
    expect(state()).toBe('waitingForInput')

    noteAgentPresence(PTY, false) // agent exits
    expect(state()).toBe('finished')

    // Relaunched WITHOUT working injection: spinners must drive again.
    noteAgentPresence(PTY, true)
    noteAgentTitle(PTY, true)
    expect(state()).toBe('running')
  })

  it('session-end acts like turn-end for state but stays silent', () => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent(hookEvent('turn-start'))
    expect(state()).toBe('running')

    noteAgentHookEvent(hookEvent('session-end')) // e.g. /clear mid-turn
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

  it('presence loss mid-turn → finished (hooks cannot report exits)', () => {
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
})

describe('fallback agents (cursor/agy) keep the spinner + settle path', () => {
  beforeEach(() => setUpCoordinator('Cursor'))
  afterEach(tearDownCoordinator)

  it('title spinner drives running; settle flips to waitingForInput and notifies', () => {
    noteAgentPresence(PTY, true)
    noteAgentTitle(PTY, true)
    expect(state()).toBe('running')

    noteAgentTitle(PTY, false) // idle title → arm settle
    expect(state()).toBe('running') // held through settle
    vi.advanceTimersByTime(WAITING_SETTLE_MS)
    expect(state()).toBe('waitingForInput')
    expect(sendOsNotification).toHaveBeenCalledTimes(1)
    expect(sendOsNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Cursor needs input' }),
    )
  })

  it('the 1 Hz presence poll must not reset the settle timer (regression)', () => {
    noteAgentPresence(PTY, true)
    noteAgentTitle(PTY, true) // spinner → running
    expect(state()).toBe('running')

    noteAgentTitle(PTY, false) // idle title → arm settle (WAITING_SETTLE_MS)
    // Presence re-emits every 1s; WAITING_SETTLE_MS is longer than one poll.
    vi.advanceTimersByTime(1000)
    noteAgentPresence(PTY, true)
    expect(state()).toBe('running') // still held mid-settle

    vi.advanceTimersByTime(1000) // total 2000ms > settle → must have fired
    expect(state()).toBe('waitingForInput')
  })

  it('resuming work before the settle fires keeps it running', () => {
    noteAgentPresence(PTY, true)
    noteAgentTitle(PTY, true)
    noteAgentTitle(PTY, false) // arm settle
    vi.advanceTimersByTime(1000)
    noteAgentTitle(PTY, true) // spinner resumed → cancel settle
    vi.advanceTimersByTime(WAITING_SETTLE_MS)
    expect(state()).toBe('running')
  })

  it('agent exit during settle resolves to finished, not waitingForInput', () => {
    noteAgentPresence(PTY, true)
    noteAgentTitle(PTY, true)
    noteAgentTitle(PTY, false) // arm settle
    noteAgentPresence(PTY, false) // process gone
    expect(state()).toBe('finished')
    vi.advanceTimersByTime(WAITING_SETTLE_MS)
    expect(state()).not.toBe('waitingForInput')
  })

  it('body spinner drives running with a static title', () => {
    noteAgentPresence(PTY, true)
    noteAgentSpinnerByte(PTY)
    expect(state()).toBe('running')

    // Frames keep arriving ~10 Hz; well within BODY_SPINNER_TIMEOUT_MS.
    vi.advanceTimersByTime(BODY_SPINNER_TIMEOUT_MS - 100)
    noteAgentSpinnerByte(PTY)
    expect(state()).toBe('running') // not expired

    // Spinner stops: body expiry, then the settle window → waitingForInput.
    vi.advanceTimersByTime(BODY_SPINNER_TIMEOUT_MS)
    expect(state()).toBe('running') // held through settle
    vi.advanceTimersByTime(WAITING_SETTLE_MS)
    expect(state()).toBe('waitingForInput')
  })

  it('interactive-mode hook events from cursor/agy are ignored (spinner owns state)', () => {
    noteAgentPresence(PTY, true)
    noteAgentHookEvent(hookEvent('turn-start', 'cursor'))
    noteAgentHookEvent(hookEvent('turn-start', 'antigravity'))
    expect(state()).toBe('waitingForInput')
    // Spinner still works after the ignored events.
    noteAgentTitle(PTY, true)
    expect(state()).toBe('running')
  })
})
