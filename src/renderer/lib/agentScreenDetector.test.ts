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
} from './agentScreenDetector'
import { useStatusStore } from '../stores/statusStore'

// Mock the notification sender so the coordinator's import graph stays light
// (the real module pulls settingsStore → logger, which starts a flush interval
// that keeps vitest from exiting). These tests assert state, not notifications.
vi.mock('./osNotificationSend', () => ({ sendOsNotification: vi.fn() }))

describe('resolveAgentState', () => {
  it('not present, never was → notRunning', () => {
    expect(resolveAgentState({ present: false, wasPresent: false, spinning: false })).toBe('notRunning')
  })

  it('disappeared after being present → finished', () => {
    expect(resolveAgentState({ present: false, wasPresent: true, spinning: false })).toBe('finished')
  })

  it('present + spinner → running', () => {
    expect(resolveAgentState({ present: true, wasPresent: true, spinning: true })).toBe('running')
  })

  it('present + no spinner → waitingForInput', () => {
    expect(resolveAgentState({ present: true, wasPresent: true, spinning: false })).toBe('waitingForInput')
  })

  it('spinner is ignored when the agent is gone', () => {
    expect(resolveAgentState({ present: false, wasPresent: false, spinning: true })).toBe('notRunning')
  })
})

describe('outputShowsBodySpinner', () => {
  it('detects pi-style body braille spinner', () => {
    expect(outputShowsBodySpinner(' ⠋ Working...')).toBe(true)
    expect(outputShowsBodySpinner('\x1b[33m ⠙ Working…\x1b[0m')).toBe(true)
  })

  it('detects OpenCode block scanner bar via its ⬝ inactive cell', () => {
    expect(outputShowsBodySpinner('▣··■⬝⬝⬝⬝⬝⬝  esc interrupt')).toBe(true)
    expect(outputShowsBodySpinner('■■■⬝⬝⬝⬝⬝')).toBe(true)
  })

  it('ignores OpenCode idle block-art (logo/borders use ▀▄█, not ⬝)', () => {
    // ■/▣ alone are NOT a working signal (progress bars / message headers);
    // only ⬝ is, so block-drawing UI must stay false.
    expect(outputShowsBodySpinner('█▀▀█ █▀▀█ █▀▀█  ┃ OpenCode ┃')).toBe(false)
    expect(outputShowsBodySpinner('▣ Build · gpt-5.2')).toBe(false)
  })

  it('ignores braille inside an OSC title (claude/codex stay title-driven)', () => {
    // claude/codex animate the spinner in the OSC 0 title, which is stripped.
    expect(outputShowsBodySpinner('\x1b]0;⠂ Respond with pong\x07')).toBe(false)
    expect(outputShowsBodySpinner('\x1b]0;⠙ cate\x07')).toBe(false)
  })

  it('ignores plain output', () => {
    expect(outputShowsBodySpinner('hello world\r\n$ ')).toBe(false)
    expect(outputShowsBodySpinner('')).toBe(false)
  })
})

describe('titleIndicatesRunning (real captured agent titles)', () => {
  // Decoded from the bell/title experiment against live `claude` and `codex`.
  it('claude idle markers → not running', () => {
    expect(titleIndicatesRunning('✳ Claude Code')).toBe(false)
    expect(titleIndicatesRunning('✱ Test schroejahr.de aufrufen')).toBe(false)
  })

  it('claude spinner frames → running', () => {
    expect(titleIndicatesRunning('⠂ Respond with pong message')).toBe(true)
    expect(titleIndicatesRunning('⠐ Claude Code')).toBe(true)
  })

  it('codex bare project name (idle) → not running', () => {
    expect(titleIndicatesRunning('cate')).toBe(false)
  })

  it('codex braille spinner frames → running', () => {
    for (const frame of ['⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏', '⠋']) {
      expect(titleIndicatesRunning(`${frame} cate`)).toBe(true)
    }
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

describe('coordinator settle timing', () => {
  const WS = 'ws-1'
  const PTY = 'pty-1'

  beforeEach(() => {
    vi.useFakeTimers()
    useStatusStore.setState({ workspaces: {}, _clearTimers: {}, terminalWorkspaceMap: {}, gitInfo: {} })
    useStatusStore.getState().ensureWorkspace(WS)
    useStatusStore.getState().registerTerminal(PTY, WS)
    startAgentScreenDetector()
  })
  afterEach(() => {
    stopAgentScreenDetector()
    vi.useRealTimers()
  })

  function state(): string | undefined {
    return useStatusStore.getState().workspaces[WS]?.agentState[PTY]
  }

  it('the 1 Hz presence poll must not reset the settle timer (regression)', () => {
    noteAgentPresence(PTY, true, 'Codex')
    noteAgentTitle(PTY, true) // spinner → running
    expect(state()).toBe('running')

    noteAgentTitle(PTY, false) // idle title → arm settle (WAITING_SETTLE_MS)
    // Presence re-emits every 1s; WAITING_SETTLE_MS is longer than one poll.
    vi.advanceTimersByTime(1000)
    noteAgentPresence(PTY, true, 'Codex')
    expect(state()).toBe('running') // still held mid-settle

    vi.advanceTimersByTime(1000) // total 2000ms > settle → must have fired
    expect(state()).toBe('waitingForInput')
  })

  it('resuming work before the settle fires keeps it running', () => {
    noteAgentPresence(PTY, true, 'Codex')
    noteAgentTitle(PTY, true)
    noteAgentTitle(PTY, false) // arm settle
    vi.advanceTimersByTime(1000)
    noteAgentTitle(PTY, true) // spinner resumed → cancel settle
    vi.advanceTimersByTime(WAITING_SETTLE_MS)
    expect(state()).toBe('running')
  })

  it('agent exit during settle resolves to finished, not waitingForInput', () => {
    noteAgentPresence(PTY, true, 'Codex')
    noteAgentTitle(PTY, true)
    noteAgentTitle(PTY, false) // arm settle
    noteAgentPresence(PTY, false, 'Codex') // process gone
    expect(state()).toBe('finished')
    vi.advanceTimersByTime(WAITING_SETTLE_MS)
    expect(state()).not.toBe('waitingForInput')
  })

  it('pi-style body spinner drives running with a static title', () => {
    noteAgentPresence(PTY, true, 'PI Agent')
    // pi never sets a title spinner; its braille frames arrive in the body.
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
})
