// =============================================================================
// Stamping rules for hook-pushed agent-session identity (agentSessionStamps.ts):
// per-agent resumability gating (claude only stamps once a turn proves the
// session is persisted), the /clear rotation (clear on session-end, re-stamp
// only after the next turn), the cwd fallback for cwd-less payloads, and dedup.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentHookEvent, AgentHookEventKind } from '../../shared/agentHooks'
import type { AgentId } from '../../shared/agents'
import type { Runtime } from '../runtime/types'
import type { TerminalAgentSession } from '../../shared/types'

const harness = vi.hoisted(() => ({
  owner: 1 as number | undefined,
  sent: [] as Array<{ channel: string; terminalId: string; session: TerminalAgentSession | null }>,
}))

vi.mock('./terminal', () => ({
  getTerminalOwner: () => harness.owner,
}))
vi.mock('../windowRegistry', () => ({
  sendToWindow: (_windowId: number, channel: string, terminalId: string, session: TerminalAgentSession | null) => {
    harness.sent.push({ channel, terminalId, session })
  },
}))

import { ingestAgentSessionStamp, clearAgentSessionStamp } from './agentSessionStamps'

let nextCwd: string | null = '/runtime-cwd'
let getCwdCalls = 0
let pendingCwd: Array<(cwd: string | null) => void> = []
const runtime = {
  process: {
    getCwd: (_id: string) => {
      getCwdCalls++
      return new Promise<string | null>((resolve) => pendingCwd.push(resolve))
    },
  },
} as unknown as Runtime

/** Resolve every in-flight getCwd and let the .then() callbacks run. */
async function resolveCwds(): Promise<void> {
  for (const resolve of pendingCwd.splice(0)) resolve(nextCwd)
  await Promise.resolve()
  await Promise.resolve()
}

function ev(
  terminalId: string,
  agentId: AgentId,
  kind: AgentHookEventKind,
  sessionId: string | null,
  cwd?: string,
): AgentHookEvent {
  return { terminalId, agentId, kind, sessionId, cwd, raw: {} }
}

const stamps = (terminalId: string) => harness.sent.filter((s) => s.terminalId === terminalId).map((s) => s.session)

let n = 0
let tid: string

beforeEach(() => {
  harness.sent.length = 0
  harness.owner = 1
  nextCwd = '/runtime-cwd'
  getCwdCalls = 0
  pendingCwd = []
  tid = `term-${++n}` // fresh terminal per test — module state is per-terminal
})

describe('claude resumability gating', () => {
  it('does not stamp on session-start (no transcript exists yet — resume would fail)', () => {
    ingestAgentSessionStamp(runtime, ev(tid, 'claude-code', 'session-start', 'id-1', '/w'))
    expect(stamps(tid)).toEqual([])
  })

  it.each(['turn-start', 'turn-end', 'permission-wait'] as const)('stamps on %s', (kind) => {
    ingestAgentSessionStamp(runtime, ev(tid, 'claude-code', 'session-start', 'id-1', '/w'))
    ingestAgentSessionStamp(runtime, ev(tid, 'claude-code', kind, 'id-1', '/w'))
    expect(stamps(tid)).toEqual([{ agentId: 'claude-code', sessionId: 'id-1', cwd: '/w' }])
  })

  it('/clear: clears on session-end, stays cleared through the rotated session-start, re-stamps on next turn', () => {
    ingestAgentSessionStamp(runtime, ev(tid, 'claude-code', 'turn-start', 'id-1', '/w'))
    ingestAgentSessionStamp(runtime, ev(tid, 'claude-code', 'session-end', 'id-1', '/w'))
    // Rotation follow-up carries the NEW id but is not yet resumable.
    ingestAgentSessionStamp(runtime, ev(tid, 'claude-code', 'session-start', 'id-2', '/w'))
    expect(stamps(tid)).toEqual([
      { agentId: 'claude-code', sessionId: 'id-1', cwd: '/w' },
      null, // a /clear'd-but-never-prompted session leaves the stamp CLEARED
    ])
    ingestAgentSessionStamp(runtime, ev(tid, 'claude-code', 'turn-start', 'id-2', '/w'))
    expect(stamps(tid).at(-1)).toEqual({ agentId: 'claude-code', sessionId: 'id-2', cwd: '/w' })
  })
})

describe('agents whose first sessionId-bearing event is already persisted', () => {
  it.each(['codex', 'cursor', 'pi', 'opencode'] as const)('%s stamps on session-start', (agentId) => {
    ingestAgentSessionStamp(runtime, ev(tid, agentId, 'session-start', 'id-1', '/w'))
    expect(stamps(tid)).toEqual([{ agentId, sessionId: 'id-1', cwd: '/w' }])
  })

  it('session-end without a follow-up clears the stamp', () => {
    ingestAgentSessionStamp(runtime, ev(tid, 'pi', 'session-start', 'id-1', '/w'))
    ingestAgentSessionStamp(runtime, ev(tid, 'pi', 'session-end', 'id-1', '/w'))
    expect(stamps(tid)).toEqual([{ agentId: 'pi', sessionId: 'id-1', cwd: '/w' }, null])
  })
})

describe('cwd fallback (payloads that carry no cwd)', () => {
  it('stamps with the terminal cwd fetched from the runtime', async () => {
    ingestAgentSessionStamp(runtime, ev(tid, 'codex', 'turn-start', 'id-1'))
    expect(stamps(tid)).toEqual([]) // async — nothing until getCwd resolves
    await resolveCwds()
    expect(stamps(tid)).toEqual([{ agentId: 'codex', sessionId: 'id-1', cwd: '/runtime-cwd' }])
  })

  it('stamps with empty cwd when the runtime cannot resolve one', async () => {
    nextCwd = null
    ingestAgentSessionStamp(runtime, ev(tid, 'codex', 'turn-end', 'id-1'))
    await resolveCwds()
    expect(stamps(tid)).toEqual([{ agentId: 'codex', sessionId: 'id-1', cwd: '' }])
  })

  it('drops an in-flight cwd lookup superseded by a clear (no resurrection)', async () => {
    ingestAgentSessionStamp(runtime, ev(tid, 'codex', 'turn-start', 'id-1'))
    clearAgentSessionStamp(tid) // agent exited while getCwd was in flight
    await resolveCwds()
    // Only the clear went out — the late cwd result must not resurrect a stamp.
    expect(stamps(tid)).toEqual([null])
  })

  it('does not call getCwd when the event carries a cwd', () => {
    ingestAgentSessionStamp(runtime, ev(tid, 'codex', 'turn-start', 'id-1', '/w'))
    expect(getCwdCalls).toBe(0)
  })
})

describe('emit mechanics', () => {
  it('ignores events with a null sessionId', () => {
    ingestAgentSessionStamp(runtime, ev(tid, 'codex', 'turn-start', null))
    expect(stamps(tid)).toEqual([])
    expect(getCwdCalls).toBe(0)
  })

  it('dedupes an unchanged stamp', () => {
    ingestAgentSessionStamp(runtime, ev(tid, 'codex', 'turn-start', 'id-1', '/w'))
    ingestAgentSessionStamp(runtime, ev(tid, 'codex', 'turn-end', 'id-1', '/w'))
    expect(stamps(tid)).toHaveLength(1)
  })

  it('sends nothing when the terminal has no owner window', () => {
    harness.owner = undefined
    ingestAgentSessionStamp(runtime, ev(tid, 'codex', 'turn-start', 'id-1', '/w'))
    expect(harness.sent).toHaveLength(0)
  })

  it('falling-edge clear emits null; the next run re-stamps from fresh events', () => {
    ingestAgentSessionStamp(runtime, ev(tid, 'codex', 'turn-start', 'id-1', '/w'))
    clearAgentSessionStamp(tid)
    expect(stamps(tid)).toEqual([{ agentId: 'codex', sessionId: 'id-1', cwd: '/w' }, null])
    ingestAgentSessionStamp(runtime, ev(tid, 'codex', 'session-start', 'id-2', '/w'))
    expect(stamps(tid).at(-1)).toEqual({ agentId: 'codex', sessionId: 'id-2', cwd: '/w' })
  })
})
