// =============================================================================
// Fallback-probe scheduling in shell.ts: the store probe runs ONCE on the
// agent-present rising edge (and only when hooks haven't identified the
// session), never periodically; the falling edge clears the stamp; the
// quit-time flush probes only hook-less terminals. Drives the real activity
// scan through fake timers with the terminal/runtime/window modules mocked.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Runtime } from '../runtime/types'
import type { TerminalAgentSession } from '../../shared/types'
import { SHELL_AGENT_SESSION_UPDATE } from '../../shared/ipc-channels'

const harness = vi.hoisted(() => ({
  ids: [] as string[],
  runtime: null as unknown,
  sessionListeners: [] as Array<() => void>,
  sent: [] as Array<{ channel: string; args: unknown[] }>,
}))

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: { on: vi.fn() },
}))
vi.mock('../logger', () => ({ default: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))
vi.mock('./terminal', () => ({
  getTerminalIds: () => harness.ids,
  getTerminalOwner: () => 1,
  getRuntimeForTerminal: () => harness.runtime,
  onTerminalSessionsChanged: (listener: () => void) => {
    harness.sessionListeners.push(listener)
    return () => {}
  },
}))
vi.mock('../windowRegistry', () => ({
  sendToWindow: (_windowId: number, channel: string, ...args: unknown[]) => {
    harness.sent.push({ channel, args })
  },
  broadcastToAll: () => {},
  isAnyWindowFocused: () => true,
}))

import { registerHandlers, flushAgentSessionStamps } from './shell'
import { ingestAgentSessionStamp, clearAgentSessionStamp } from './agentSessionStamps'

interface FakeScan {
  agentPresent: boolean
}

const scans = new Map<string, FakeScan>()
const probeAgentSession = vi.fn(async (id: string): Promise<TerminalAgentSession | null> => ({
  agentId: 'claude-code',
  sessionId: `probed-${id}`,
  cwd: '/w',
}))

const runtime = {
  process: {
    scanActivity: async (ids: string[]) =>
      Object.fromEntries(
        ids
          .filter((id) => scans.has(id))
          .map((id) => [
            id,
            {
              activity: { type: 'running', processName: 'agent' },
              agentName: 'Agent',
              agentPresent: scans.get(id)!.agentPresent,
            },
          ]),
      ),
    probeAgentSession,
    getCwd: async () => '/w',
    scanPorts: async () => ({}),
  },
} as unknown as Runtime

const stampUpdates = () =>
  harness.sent
    .filter((s) => s.channel === SHELL_AGENT_SESSION_UPDATE)
    .map((s) => ({ terminalId: s.args[0] as string, session: s.args[1] as TerminalAgentSession | null }))

let n = 0
function addTerminal(agentPresent: boolean): string {
  const id = `sh-term-${++n}`
  harness.ids.push(id)
  scans.set(id, { agentPresent })
  harness.sessionListeners.forEach((l) => l())
  return id
}

async function tick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1000)
}

registerHandlers()

beforeEach(() => {
  vi.useFakeTimers()
  harness.runtime = runtime
  harness.sent.length = 0
  probeAgentSession.mockClear()
})

afterEach(async () => {
  // Drop all terminals so the poll loop stops between tests.
  harness.ids.length = 0
  scans.clear()
  harness.sessionListeners.forEach((l) => l())
  vi.useRealTimers()
})

describe('rising-edge fallback probe', () => {
  it('probes once on the rising edge and never again on later scans', async () => {
    const id = addTerminal(true)
    await tick()
    expect(probeAgentSession).toHaveBeenCalledTimes(1)
    expect(stampUpdates()).toEqual([
      { terminalId: id, session: { agentId: 'claude-code', sessionId: `probed-${id}`, cwd: '/w' } },
    ])
    // 30 more scan cycles — no periodic re-probe (the 20s loop is gone).
    for (let i = 0; i < 30; i++) await tick()
    expect(probeAgentSession).toHaveBeenCalledTimes(1)
  })

  it('skips the probe when hooks already identified the session', async () => {
    const id = addTerminal(true)
    ingestAgentSessionStamp(runtime, {
      terminalId: id,
      agentId: 'codex',
      kind: 'turn-start',
      sessionId: 'hook-id',
      cwd: '/w',
      raw: {},
    })
    await tick()
    expect(probeAgentSession).not.toHaveBeenCalled()
    expect(stampUpdates()).toEqual([
      { terminalId: id, session: { agentId: 'codex', sessionId: 'hook-id', cwd: '/w' } },
    ])
  })

  it('clears the stamp on the falling edge and re-probes a hook-less relaunch', async () => {
    const id = addTerminal(true)
    await tick()
    expect(probeAgentSession).toHaveBeenCalledTimes(1)
    scans.get(id)!.agentPresent = false
    await tick()
    expect(stampUpdates().at(-1)).toEqual({ terminalId: id, session: null })
    scans.get(id)!.agentPresent = true // relaunch, still no hooks
    await tick()
    expect(probeAgentSession).toHaveBeenCalledTimes(2)
  })
})

describe('suspended-terminal scan omission', () => {
  it('carries agent presence when the scan result omits the terminal entirely', async () => {
    const id = addTerminal(true)
    await tick() // rising edge — probe + stamp
    harness.sent.length = 0
    probeAgentSession.mockClear()

    // (a) The daemon omits SIGSTOP-suspended ptys from scanActivity results —
    // the entry vanishes while the agent is alive but frozen. No falling edge,
    // stamp kept, still eligible for the quit-time flush.
    scans.delete(id)
    await tick()
    await tick()
    expect(stampUpdates()).toEqual([]) // no phantom clear
    await flushAgentSessionStamps(500)
    expect(probeAgentSession.mock.calls.map((c) => c[0])).toEqual([id])
    harness.sent.length = 0

    // (b) A PRESENT entry with agentPresent:false is a real exit — still clears.
    scans.set(id, { agentPresent: false })
    await tick()
    expect(stampUpdates().at(-1)).toEqual({ terminalId: id, session: null })
  })
})

describe('flushAgentSessionStamps', () => {
  it('probes hook-less agent terminals only', async () => {
    const hookless = addTerminal(true)
    const hooked = addTerminal(true)
    const noAgent = addTerminal(false)
    ingestAgentSessionStamp(runtime, {
      terminalId: hooked,
      agentId: 'codex',
      kind: 'turn-start',
      sessionId: 'hook-id',
      cwd: '/w',
      raw: {},
    })
    await tick() // establish previousAgentPresent (rising-edge probe fires for hookless)
    probeAgentSession.mockClear()
    harness.sent.length = 0

    await flushAgentSessionStamps(500)
    expect(probeAgentSession.mock.calls.map((c) => c[0])).toEqual([hookless])
    expect(stampUpdates()).toEqual([]) // same result as the rising-edge probe — deduped
    expect(probeAgentSession.mock.calls.map((c) => c[0])).not.toContain(noAgent)
    // Reset hook authority for cleanliness of shared module state.
    clearAgentSessionStamp(hooked)
  })
})
