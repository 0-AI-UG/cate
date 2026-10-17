import { describe, expect, it, vi } from 'vitest'
import type { AgentHookEvent } from '../../contract'
import { createAgentTitleTracker, normalizeAgentTitle } from './tracker'
import type { AgentSessionStores } from './types'

function event(overrides: Partial<AgentHookEvent> = {}): AgentHookEvent {
  return {
    terminalId: 'pty-1',
    agentId: 'codex',
    kind: 'turn-end',
    sessionId: 'session-1',
    raw: {},
    ...overrides,
  }
}

function stores(title: () => Promise<string | null>): AgentSessionStores {
  return new Proxy({}, { get: () => ({ title, conversation: async () => null }) }) as AgentSessionStores
}

describe('agent title tracker', () => {
  it('normalizes titles into bounded single-line labels', () => {
    expect(normalizeAgentTitle('  Fix\n  terminal   titles ')).toBe('Fix terminal titles')
    expect(normalizeAgentTitle('x'.repeat(140))).toBe(`${'x'.repeat(119)}…`)
    expect(normalizeAgentTitle(' \n ')).toBeNull()
  })

  it('retries delayed CLI metadata and emits one native title', async () => {
    vi.useFakeTimers()
    let attempts = 0
    const emit = vi.fn()
    const tracker = createAgentTitleTracker({
      homeDir: '/home/me',
      stores: stores(async () => ++attempts < 3 ? null : 'Native title'),
      emit,
      retryDelaysMs: [0, 10, 20],
    })

    tracker.note(event())
    await vi.advanceTimersByTimeAsync(20)

    expect(attempts).toBe(3)
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'session-title',
      sessionId: 'session-1',
      title: 'Native title',
    }))
    tracker.dispose()
    vi.useRealTimers()
  })

  it('cancels stale retries when a session rotates', async () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const tracker = createAgentTitleTracker({
      homeDir: '/home/me',
      stores: stores(async () => null),
      emit,
      retryDelaysMs: [0, 10],
    })
    tracker.note(event())
    await vi.advanceTimersByTimeAsync(0)
    tracker.note(event({ kind: 'session-end' }))
    await vi.advanceTimersByTimeAsync(20)
    expect(emit).not.toHaveBeenCalled()
    tracker.dispose()
    vi.useRealTimers()
  })

  it('delivers the same resumed session title to each terminal', async () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const tracker = createAgentTitleTracker({
      homeDir: '/home/me',
      stores: stores(async () => 'Shared session'),
      emit,
      retryDelaysMs: [0],
    })

    tracker.note(event({ terminalId: 'pty-1' }))
    tracker.note(event({ terminalId: 'pty-2' }))
    await vi.advanceTimersByTimeAsync(0)

    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit.mock.calls.map(([value]) => value.terminalId)).toEqual(['pty-1', 'pty-2'])
    tracker.dispose()
    vi.useRealTimers()
  })

  it('ignores an in-flight lookup after the terminal id is forgotten and reused', async () => {
    vi.useFakeTimers()
    let finishOld!: (title: string) => void
    const emit = vi.fn()
    const resolve = vi.fn()
      .mockImplementationOnce(() => new Promise<string>(done => { finishOld = done }))
      .mockResolvedValue('New session title')
    const tracker = createAgentTitleTracker({
      homeDir: '/home/me', stores: stores(resolve), emit, retryDelaysMs: [0],
    })
    try {
      tracker.note(event())
      await vi.advanceTimersByTimeAsync(0)
      tracker.forget('pty-1')
      tracker.note(event({ sessionId: 'session-2' }))
      await vi.advanceTimersByTimeAsync(0)
      finishOld('Stale title')
      await vi.advanceTimersByTimeAsync(0)
      expect(emit).toHaveBeenCalledTimes(1)
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-2', title: 'New session title' }))
    } finally {
      tracker.dispose()
      vi.useRealTimers()
    }
  })
})
