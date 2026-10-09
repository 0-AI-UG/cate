import { describe, expect, it, vi } from 'vitest'
import type { AgentRunner, PanelAgentState } from '../contract'
import { createRunnerRegistry, type AgentRunnerImpl } from './registry'

function fakeRunner(kind: AgentRunner) {
  const states = new Map<string, PanelAgentState>()
  const listeners = new Set<(panelId: string) => void>()
  const runner: AgentRunnerImpl = {
    kind,
    state: (panelId) => states.get(panelId) ?? null,
    panelIds: () => states.keys(),
    send: vi.fn(async () => ({ ok: true as const })),
    conversation: async () => null,
    interrupt: vi.fn(async () => ({ ok: true as const })),
    onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const set = (panelId: string, state: Partial<PanelAgentState> | null) => {
    if (state) {
      states.set(panelId, {
        panelId, agentId: null, agentName: null, label: null, takesOverPanel: kind === 'terminal', contextPolicy: null, status: 'waitingForInput',
        present: true, canReceivePrompt: true, session: null, ...state,
      })
    } else states.delete(panelId)
    for (const listener of listeners) listener(panelId)
  }
  return { runner, set }
}

describe('runner registry', () => {
  it('answers which runner hosts a panel', () => {
    const registry = createRunnerRegistry()
    const terminal = fakeRunner('terminal')
    const t3 = fakeRunner('t3')
    registry.register(terminal.runner)
    registry.register(t3.runner)
    terminal.set('term', { agentId: 'codex' })
    t3.set('chat', { agentId: 'claude-code' })
    expect(registry.sessionFor('term')).toMatchObject({ agentId: 'codex' })
    expect(registry.runnerFor('term')).toBe(terminal.runner)
    expect(registry.runnerFor('chat')).toBe(t3.runner)
    expect(registry.sessionFor('editor')).toBeNull()
    expect(Object.keys(registry.all()).sort()).toEqual(['chat', 'term'])
  })

  it('publishes changes only when a panel\'s state actually changed, and removals as null', () => {
    const registry = createRunnerRegistry()
    const terminal = fakeRunner('terminal')
    registry.register(terminal.runner)
    const changes = vi.fn()
    registry.subscribe(changes)
    terminal.set('term', { status: 'running' })
    terminal.set('term', { status: 'running' })
    expect(changes).toHaveBeenCalledTimes(1)
    expect(changes).toHaveBeenLastCalledWith({ term: expect.objectContaining({ status: 'running' }) })
    terminal.set('term', null)
    expect(changes).toHaveBeenLastCalledWith({ term: null })
  })

  it('drops a runner\'s panels when it unregisters', () => {
    const registry = createRunnerRegistry()
    const terminal = fakeRunner('terminal')
    const off = registry.register(terminal.runner)
    terminal.set('term', {})
    const changes = vi.fn()
    registry.subscribe(changes)
    off()
    expect(changes).toHaveBeenCalledWith({ term: null })
    expect(registry.sessionFor('term')).toBeNull()
  })

  it('adds when context was last sent and republishes on refresh', () => {
    const sent = new Map<string, number>()
    const registry = createRunnerRegistry({ contextSentAt: (panelId) => sent.get(panelId) })
    const terminal = fakeRunner('terminal')
    registry.register(terminal.runner)
    terminal.set('term', {})
    expect(registry.sessionFor('term')).not.toHaveProperty('contextSentAt')
    const changes = vi.fn()
    registry.subscribe(changes)
    sent.set('term', 42)
    registry.refresh('term')
    expect(changes).toHaveBeenCalledWith({ term: expect.objectContaining({ contextSentAt: 42 }) })
    expect(registry.all().term.contextSentAt).toBe(42)
  })
})
