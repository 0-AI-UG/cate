import { describe, expect, it, vi } from 'vitest'
import type { PanelAgentState } from '../contract'
import { createAgentPanels, type AgentPanelSource } from './panels'

function fakeSource() {
  const states = new Map<string, PanelAgentState>()
  const listeners = new Set<(panelId: string) => void>()
  const source: AgentPanelSource = {
    state: (panelId) => states.get(panelId) ?? null,
    panelIds: () => states.keys(),
    onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const set = (panelId: string, state: Partial<PanelAgentState> | null) => {
    if (state) {
      states.set(panelId, {
        panelId, agentId: null, agentName: null, label: null, contextPolicy: null, status: 'waitingForInput',
        present: true, canReceivePrompt: true, session: null, ...state,
      })
    } else states.delete(panelId)
    for (const listener of listeners) listener(panelId)
  }
  return { source, set }
}

describe('agent panels', () => {
  it('answers what each panel hosts', () => {
    const terminal = fakeSource()
    terminal.set('term', { agentId: 'codex' })
    const panels = createAgentPanels(terminal.source)
    terminal.set('term-2', { agentId: 'claude-code' })
    expect(panels.state('term')).toMatchObject({ agentId: 'codex' })
    expect(panels.state('editor')).toBeNull()
    expect(Object.keys(panels.all()).sort()).toEqual(['term', 'term-2'])
  })

  it('publishes changes only when a panel\'s state actually changed, and removals as null', () => {
    const terminal = fakeSource()
    const panels = createAgentPanels(terminal.source)
    const changes = vi.fn()
    panels.subscribe(changes)
    terminal.set('term', { status: 'running' })
    terminal.set('term', { status: 'running' })
    expect(changes).toHaveBeenCalledTimes(1)
    expect(changes).toHaveBeenLastCalledWith({ term: expect.objectContaining({ status: 'running' }) })
    terminal.set('term', null)
    expect(changes).toHaveBeenLastCalledWith({ term: null })
  })

  it('stops following its source when disposed', () => {
    const terminal = fakeSource()
    const panels = createAgentPanels(terminal.source)
    const changes = vi.fn()
    panels.subscribe(changes)
    panels.dispose()
    terminal.set('term', {})
    expect(changes).not.toHaveBeenCalled()
  })

  it('adds when context was last sent and republishes on refresh', () => {
    const sent = new Map<string, number>()
    const terminal = fakeSource()
    const panels = createAgentPanels(terminal.source, { contextSentAt: (panelId) => sent.get(panelId) })
    terminal.set('term', {})
    expect(panels.state('term')).not.toHaveProperty('contextSentAt')
    const changes = vi.fn()
    panels.subscribe(changes)
    sent.set('term', 42)
    panels.refresh('term')
    expect(changes).toHaveBeenCalledWith({ term: expect.objectContaining({ contextSentAt: 42 }) })
    expect(panels.all().term.contextSentAt).toBe(42)
  })
})
