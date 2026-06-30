import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentState } from '../../shared/types'

// The wake watcher reads a terminal's agentState via cateAgentTerminals and
// re-prompts via cateAgentSession — mock both so we can drive transitions and
// assert the re-prompt. agentModelPrefs is mocked so module load is store-free.
const { promptCateAgent, agentStates, activeStates } = vi.hoisted(() => ({
  promptCateAgent: vi.fn(async (_panelId: string, _text: string) => {}),
  agentStates: new Map<string, AgentState | null>(),
  activeStates: new Map<string, boolean>(),
}))

vi.mock('./cateAgentSession', () => ({
  promptCateAgent,
  createCateAgentSession: vi.fn(async () => true),
  disposeCateAgent: vi.fn(async () => {}),
  driverPanelId: (key: string) => `cate-agent-driver:${key}`,
}))

vi.mock('./cateAgentTerminals', () => ({
  ptyFor: (id: string) => `pty-${id}`,
  agentStateFor: (_ws: string, ptyId: string) => agentStates.get(ptyId) ?? null,
  activityRunning: (_ws: string, ptyId: string) => activeStates.get(ptyId) ?? false,
  readTerminalState: vi.fn(async () => ({ output: 'final screen', isRunning: false, lastExitCode: null, agentState: 'finished' as AgentState })),
  closeCanvasPanel: vi.fn(),
  openTerminal: vi.fn(async () => 'term-x'),
  shortId: (id: string) => id.slice(0, 8),
}))

vi.mock('../../agent/renderer/agentModelPrefs', () => ({
  loadCateAgentOrchestratorAgentCommand: () => 'claude',
}))

import { armBackgroundSend, disarmWakesForDriver } from './codingAgentLauncher'
import { driverOutstanding } from './cateAgentRunWaiters'
import { setContext, setTerminalOwner } from './cateAgentContextRegistry'
import { useStatusStore } from '../stores/statusStore'

function bump(): void {
  // Any setState fires the watcher's subscription.
  useStatusStore.setState((s) => ({ ...s }))
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('backgrounded send_keys wake', () => {
  beforeEach(() => {
    promptCateAgent.mockClear()
    agentStates.clear()
    activeStates.clear()
    // Drain any wakes a prior test left armed so the module-level sweep timer stops
    // and doesn't leak across tests.
    for (const id of ['itA', 'itB', 'itL', 'itF', 'itS', 'itR', 'itCmd', 'itCmdStuck']) disarmWakesForDriver(`cate-agent-driver:${id}`)
  })

  it('fires on running -> finished and re-prompts the owning driver', async () => {
    setTerminalOwner('term-A', 'cate-agent-driver:itA')
    setContext('cate-agent-driver:itA', { panelId: 'cate-agent-driver:itA', workspaceId: 'ws', rootPath: '/r', role: 'driver' })
    agentStates.set('pty-term-A', 'running')

    armBackgroundSend('ws', 'term-A')
    expect(driverOutstanding('cate-agent-driver:itA')).toBe(1)

    agentStates.set('pty-term-A', 'finished')
    bump()
    await flush()

    expect(driverOutstanding('cate-agent-driver:itA')).toBe(0)
    expect(promptCateAgent).toHaveBeenCalledTimes(1)
    expect(promptCateAgent.mock.calls[0][0]).toBe('cate-agent-driver:itA')
  })

  it('fires when an interactive coding agent completes its turn (running -> waitingForInput)', async () => {
    // THE BUG: an interactive CLI (claude/codex) that finishes a turn stays ALIVE
    // at its prompt — its agentState becomes `waitingForInput`, NOT `finished`.
    // `finished` is reserved for the CLI process actually exiting (!present &&
    // wasPresent). So a completed turn is the running -> waitingForInput edge, gated
    // on "has run since arming". Waiting for `finished` here means the driver never
    // continues — the status reader is correct, the driver just never wakes.
    setTerminalOwner('term-B', 'cate-agent-driver:itB')
    setContext('cate-agent-driver:itB', { panelId: 'cate-agent-driver:itB', workspaceId: 'ws', rootPath: '/r', role: 'driver' })
    agentStates.set('pty-term-B', 'running')

    armBackgroundSend('ws', 'term-B')
    expect(driverOutstanding('cate-agent-driver:itB')).toBe(1)

    // Turn completes: the agent returns to its prompt (still present, not spinning).
    agentStates.set('pty-term-B', 'waitingForInput')
    bump()
    await flush()

    expect(driverOutstanding('cate-agent-driver:itB')).toBe(0)
    expect(promptCateAgent).toHaveBeenCalledTimes(1)
    expect(promptCateAgent.mock.calls[0][0]).toBe('cate-agent-driver:itB')
  })

  it('does NOT wake during launch while parked at a trust/permission prompt (never ran)', async () => {
    // The launch-phase guard: arming happens as the task is submitted, but the agent
    // may still be sitting at a trust/permission prompt (waitingForInput) and has not
    // started a turn yet. That launch-phase waitingForInput must NOT be mistaken for a
    // completed turn — only STUCK (much later) may nudge it.
    setTerminalOwner('term-L', 'cate-agent-driver:itL')
    setContext('cate-agent-driver:itL', { panelId: 'cate-agent-driver:itL', workspaceId: 'ws', rootPath: '/r', role: 'driver' })
    agentStates.set('pty-term-L', 'waitingForInput') // never ran

    armBackgroundSend('ws', 'term-L')
    expect(driverOutstanding('cate-agent-driver:itL')).toBe(1)

    // A dialog-clearing keystroke; still parked at the prompt, still never ran.
    bump()
    await flush()

    expect(driverOutstanding('cate-agent-driver:itL')).toBe(1) // still outstanding
    expect(promptCateAgent).not.toHaveBeenCalled()
  })

  it('fires on finished even when running was never sampled', async () => {
    setTerminalOwner('term-F', 'cate-agent-driver:itF')
    setContext('cate-agent-driver:itF', { panelId: 'cate-agent-driver:itF', workspaceId: 'ws', rootPath: '/r', role: 'driver' })
    agentStates.set('pty-term-F', 'waitingForInput')

    armBackgroundSend('ws', 'term-F')
    // Jump straight to finished without ever observing 'running' (states coalesce).
    agentStates.set('pty-term-F', 'finished')
    bump()
    await flush()

    expect(driverOutstanding('cate-agent-driver:itF')).toBe(0)
    expect(promptCateAgent).toHaveBeenCalledTimes(1)
  })

  it('fires STUCK when a backgrounded agent never starts and sits in waitingForInput', async () => {
    vi.useFakeTimers()
    try {
      setTerminalOwner('term-S', 'cate-agent-driver:itS')
      setContext('cate-agent-driver:itS', { panelId: 'cate-agent-driver:itS', workspaceId: 'ws', rootPath: '/r', role: 'driver' })
      agentStates.set('pty-term-S', 'waitingForInput')

      armBackgroundSend('ws', 'term-S')
      // First sweep records waitingSince; it never reaches 'running'.
      bump()
      expect(driverOutstanding('cate-agent-driver:itS')).toBe(1)

      // Advance past the stuck window; the timer-driven sweep should fire.
      await vi.advanceTimersByTimeAsync(95_000)

      expect(driverOutstanding('cate-agent-driver:itS')).toBe(0)
      expect(promptCateAgent).toHaveBeenCalledTimes(1)
      expect(promptCateAgent.mock.calls[0][1]).toContain("hasn't started")
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-arms and wakes again when the driver nudges a completed agent', async () => {
    // After a turn-complete wake the driver may send_keys another prompt
    // (background:true) to nudge the agent — which re-arms the wake. The second turn
    // completing must wake the driver again. Each completion is one outstanding send.
    setTerminalOwner('term-R', 'cate-agent-driver:itR')
    setContext('cate-agent-driver:itR', { panelId: 'cate-agent-driver:itR', workspaceId: 'ws', rootPath: '/r', role: 'driver' })
    agentStates.set('pty-term-R', 'running')

    armBackgroundSend('ws', 'term-R')

    // First turn completes -> wake, counter back to zero.
    agentStates.set('pty-term-R', 'waitingForInput')
    bump()
    await flush()
    expect(promptCateAgent).toHaveBeenCalledTimes(1)
    expect(driverOutstanding('cate-agent-driver:itR')).toBe(0)

    // Driver nudges: re-send while parked at the prompt -> re-arm (everRunning reset).
    armBackgroundSend('ws', 'term-R')
    expect(driverOutstanding('cate-agent-driver:itR')).toBe(1)

    agentStates.set('pty-term-R', 'running') // working again
    bump()
    await flush()
    agentStates.set('pty-term-R', 'waitingForInput') // done again
    bump()
    await flush()

    expect(promptCateAgent).toHaveBeenCalledTimes(2)
    expect(driverOutstanding('cate-agent-driver:itR')).toBe(0)
  })

  it('fires DONE for a non-agent command when it goes busy -> idle', async () => {
    setTerminalOwner('term-Cmd', 'cate-agent-driver:itCmd')
    setContext('cate-agent-driver:itCmd', { panelId: 'cate-agent-driver:itCmd', workspaceId: 'ws', rootPath: '/r', role: 'driver' })
    // No agent ever present; the foreground process (a build) is running.
    activeStates.set('pty-term-Cmd', true)

    armBackgroundSend('ws', 'term-Cmd')
    bump()
    expect(driverOutstanding('cate-agent-driver:itCmd')).toBe(1)

    // Command finishes → terminal goes idle.
    activeStates.set('pty-term-Cmd', false)
    bump()
    await flush()

    expect(driverOutstanding('cate-agent-driver:itCmd')).toBe(0)
    expect(promptCateAgent).toHaveBeenCalledTimes(1)
  })

  it('fires STUCK for a backgrounded command that never goes busy', async () => {
    vi.useFakeTimers()
    try {
      setTerminalOwner('term-CmdS', 'cate-agent-driver:itCmdStuck')
      setContext('cate-agent-driver:itCmdStuck', { panelId: 'cate-agent-driver:itCmdStuck', workspaceId: 'ws', rootPath: '/r', role: 'driver' })
      // Never any agent, never any foreground activity (command never submitted).
      armBackgroundSend('ws', 'term-CmdS')
      bump()
      await vi.advanceTimersByTimeAsync(95_000)

      expect(driverOutstanding('cate-agent-driver:itCmdStuck')).toBe(0)
      expect(promptCateAgent).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a terminal no driver owns arms nothing', () => {
    armBackgroundSend('ws', 'unowned-term')
    expect(driverOutstanding('cate-agent-driver:none')).toBe(0)
  })
})
