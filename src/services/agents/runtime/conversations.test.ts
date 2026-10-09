import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyAgentConversationChange,
  diffAgentConversation,
  type AgentConversation,
  type AgentConversationChange,
  type AgentConversationMessage,
  type AgentRunner,
  type AgentStatus,
  type PanelAgentState,
} from '../contract'
import { createAgentConversations } from './conversations'
import { createRunnerRegistry, type AgentRunnerImpl } from './registry'

const session = { agentId: 'claude-code' as const, runner: 'terminal' as const, sessionId: 's1', cwd: '/repo' }

function setup() {
  const states = new Map<string, PanelAgentState>()
  const listeners = new Set<(panelId: string) => void>()
  let messages: AgentConversationMessage[] = []
  let stamp = 'a'
  const conversation = vi.fn(async () => ({ session, messages: [...messages] }))
  const runner: AgentRunnerImpl = {
    kind: 'terminal' as AgentRunner,
    state: (panelId) => states.get(panelId) ?? null,
    panelIds: () => states.keys(),
    send: async () => ({ ok: true }),
    interrupt: async () => ({ ok: true }),
    conversation,
    conversationStamp: async () => stamp,
    onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const registry = createRunnerRegistry()
  registry.register(runner)
  const setStatus = (status: AgentStatus) => {
    states.set('p1', {
      panelId: 'p1', agentId: 'claude-code', agentName: 'Claude Code', label: 'Claude Code', takesOverPanel: true, contextPolicy: null, status,
      present: true, canReceivePrompt: status === 'waitingForInput', session,
    })
    for (const listener of listeners) listener('p1')
  }
  const write = (next: AgentConversationMessage[]) => {
    messages = next
    stamp += 'a'
  }
  return { registry, conversation, setStatus, write }
}

describe('agent conversations', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('sends the conversation once read, then each change while the agent works', async () => {
    const { registry, setStatus, write } = setup()
    setStatus('running')
    write([{ role: 'user', text: 'fix it' }])
    const conversations = createAgentConversations({ registry, workingMs: 100, settleMs: [] })
    const seen: Array<{ conversation: AgentConversation; change: AgentConversationChange | null }> = []
    conversations.watch('p1', (conversation, change) => { seen.push({ conversation, change }) })
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toEqual([{ conversation: { status: 'running', canReceivePrompt: false, messages: [{ role: 'user', text: 'fix it' }] }, change: null }])

    write([{ role: 'user', text: 'fix it' }, { role: 'assistant', text: 'On it' }])
    await vi.advanceTimersByTimeAsync(100)
    expect(seen[1].change).toEqual({ from: 1, messages: [{ role: 'assistant', text: 'On it' }] })

    write([{ role: 'user', text: 'fix it' }, { role: 'assistant', text: 'On it\n\nDone.' }])
    await vi.advanceTimersByTimeAsync(100)
    expect(seen[2].change).toEqual({ from: 1, messages: [{ role: 'assistant', text: 'On it\n\nDone.' }] })
    conversations.dispose()
  })

  it('sends a turn that ended with its reply', async () => {
    const { registry, setStatus, write } = setup()
    setStatus('running')
    const conversations = createAgentConversations({ registry, workingMs: 10_000, settleMs: [] })
    const changes: AgentConversationChange[] = []
    conversations.watch('p1', (_conversation, change) => { if (change) changes.push(change) })
    await vi.advanceTimersByTimeAsync(0)
    write([{ role: 'assistant', text: 'All done' }])
    setStatus('waitingForInput')
    await vi.advanceTimersByTimeAsync(0)
    expect(changes).toEqual([{ status: 'waitingForInput', canReceivePrompt: true, from: 0, messages: [{ role: 'assistant', text: 'All done' }] }])
    conversations.dispose()
  })

  it('reads the store only when its stamp moved', async () => {
    const { registry, conversation, setStatus } = setup()
    setStatus('running')
    const conversations = createAgentConversations({ registry, workingMs: 100, settleMs: [] })
    const stop = conversations.watch('p1', () => {})
    await vi.advanceTimersByTimeAsync(500)
    expect(conversation).toHaveBeenCalledTimes(1)
    stop()
    await vi.advanceTimersByTimeAsync(500)
    expect(conversation).toHaveBeenCalledTimes(1)
  })
})

describe('conversation changes', () => {
  const base: AgentConversation = { status: 'running', canReceivePrompt: false, messages: [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }] }

  it('round-trips through apply', () => {
    const next: AgentConversation = { status: 'waitingForInput', canReceivePrompt: true, messages: [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'bc' }, { role: 'user', text: 'd' }] }
    const change = diffAgentConversation(base, next)!
    expect(change).toEqual({ status: 'waitingForInput', canReceivePrompt: true, from: 1, messages: next.messages.slice(1) })
    expect(applyAgentConversationChange(base, change)).toEqual(next)
  })

  it('is null for the same conversation, and truncates a shorter one', () => {
    expect(diffAgentConversation(base, { ...base, messages: [...base.messages] })).toBeNull()
    expect(diffAgentConversation(base, { ...base, messages: base.messages.slice(0, 1) })).toEqual({ from: 1, messages: [] })
  })
})
