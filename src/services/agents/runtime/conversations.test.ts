import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentStep,
  applyAgentConversationChange,
  diffAgentConversation,
  type AgentConversation,
  type AgentConversationChange,
  type AgentConversationMessage,
  type AgentStatus,
  type AgentStep,
  type PanelAgentState,
} from '../contract'
import { createAgentConversations } from './conversations'
import type { AgentTerminals } from './core'
import { createAgentPanels } from './panels'
import { createAgentPrompts } from './prompts'

const session = { agentId: 'claude-code' as const, sessionId: 's1', cwd: '/repo' }

function setup() {
  const states = new Map<string, PanelAgentState>()
  const listeners = new Set<(panelId: string) => void>()
  const resetListeners = new Set<(panelId: string) => void>()
  const reset = () => { for (const listener of resetListeners) listener('p1') }
  const stepListeners = new Set<(panelId: string, step: AgentStep) => void>()
  let messages: AgentConversationMessage[] = []
  let stamp = 'a'
  const conversation = vi.fn(async (): Promise<{ session: typeof session; messages: AgentConversationMessage[] } | null> => ({ session, messages: [...messages] }))
  const terminals: AgentTerminals = {
    state: (panelId) => states.get(panelId) ?? null,
    panelIds: () => states.keys(),
    send: async () => ({ ok: true }),
    interrupt: async () => ({ ok: true }),
    conversation,
    conversationStamp: async () => stamp,
    onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    onStep: (listener) => { stepListeners.add(listener); return () => { stepListeners.delete(listener) } },
    onConversationReset: (listener) => { resetListeners.add(listener); return () => { resetListeners.delete(listener) } },
    dispose: () => {},
  }
  const step = (panelId: string, next: AgentStep) => { for (const listener of stepListeners) listener(panelId, next) }
  const panels = createAgentPanels(terminals)
  const prompts = createAgentPrompts({ panels, terminals })
  const setStatus = (status: AgentStatus, activeSession = session) => {
    states.set('p1', {
      panelId: 'p1', agentId: 'claude-code', agentName: 'Claude Code', label: 'Claude Code', contextPolicy: null, status,
      present: true, canReceivePrompt: status === 'waitingForInput', session: activeSession,
    })
    for (const listener of listeners) listener('p1')
  }
  const write = (next: AgentConversationMessage[]) => {
    messages = next
    stamp += 'a'
  }
  /** The panel hosts no agent any more (closed). */
  const remove = () => {
    states.delete('p1')
    for (const listener of listeners) listener('p1')
  }
  return { panels, terminals, prompts, conversation, setStatus, write, step, remove, reset }
}

describe('agent conversations', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('sends the conversation once read, then each change while the agent works', async () => {
    const { panels, terminals, prompts, setStatus, write } = setup()
    setStatus('running')
    write([{ role: 'user', text: 'fix it' }])
    const conversations = createAgentConversations({ panels, terminals, prompts, workingMs: 100, settleMs: [] })
    const seen: Array<{ conversation: AgentConversation; change: AgentConversationChange | null }> = []
    conversations.watch('p1', (conversation, change) => { seen.push({ conversation, change }) })
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toEqual([{
      conversation: { generation: 0, status: 'running', canReceivePrompt: false, messages: [{ role: 'user', text: 'fix it' }], steps: [], stepsSince: expect.any(String), prompts: [] },
      change: null,
    }])

    write([{ role: 'user', text: 'fix it' }, { role: 'assistant', text: 'On it' }])
    await vi.advanceTimersByTimeAsync(100)
    expect(seen[1].change).toEqual({ from: 1, messages: [{ role: 'assistant', text: 'On it' }] })

    write([{ role: 'user', text: 'fix it' }, { role: 'assistant', text: 'On it\n\nDone.' }])
    await vi.advanceTimersByTimeAsync(100)
    expect(seen[2].change).toEqual({ from: 1, messages: [{ role: 'assistant', text: 'On it\n\nDone.' }] })
    conversations.dispose()
  })

  it('sends a turn that ended with its reply', async () => {
    const { panels, terminals, prompts, setStatus, write } = setup()
    setStatus('running')
    const conversations = createAgentConversations({ panels, terminals, prompts, workingMs: 10_000, settleMs: [] })
    const changes: AgentConversationChange[] = []
    conversations.watch('p1', (_conversation, change) => { if (change) changes.push(change) })
    await vi.advanceTimersByTimeAsync(0)
    write([{ role: 'assistant', text: 'All done' }])
    setStatus('waitingForInput')
    await vi.advanceTimersByTimeAsync(0)
    expect(changes).toEqual([{ status: 'waitingForInput', canReceivePrompt: true, from: 0, messages: [{ role: 'assistant', text: 'All done' }] }])
    conversations.dispose()
  })

  it('holds a turn\'s end until its reply is read, then sends both together', async () => {
    const { panels, terminals, prompts, setStatus, write } = setup()
    setStatus('running')
    write([{ role: 'user', text: 'fix it' }])
    const conversations = createAgentConversations({ panels, terminals, prompts, workingMs: 100, settleMs: [], endMs: 1_000 })
    const changes: AgentConversationChange[] = []
    conversations.watch('p1', (_conversation, change) => { if (change) changes.push(change) })
    await vi.advanceTimersByTimeAsync(0)
    setStatus('waitingForInput')
    await vi.advanceTimersByTimeAsync(0)
    expect(changes).toEqual([])
    write([{ role: 'user', text: 'fix it' }, { role: 'assistant', text: 'Fixed.' }])
    await vi.advanceTimersByTimeAsync(100)
    expect(changes).toEqual([{ status: 'waitingForInput', canReceivePrompt: true, from: 1, messages: [{ role: 'assistant', text: 'Fixed.' }] }])
    conversations.dispose()
  })

  it('waits for a reply after the last step, and ends without one after a while', async () => {
    const { panels, terminals, prompts, setStatus, write, step } = setup()
    setStatus('running')
    write([{ role: 'user', text: 'fix it', createdAt: '2026-01-01T00:00:00.000Z' }, { role: 'assistant', text: 'Looking', createdAt: '2026-01-01T00:00:01.000Z' }])
    const conversations = createAgentConversations({ panels, terminals, prompts, workingMs: 100, settleMs: [], endMs: 1_000 })
    const changes: AgentConversationChange[] = []
    conversations.watch('p1', (_conversation, change) => { if (change) changes.push(change) })
    await vi.advanceTimersByTimeAsync(0)
    step('p1', { tool: 'Bash', subject: 'npm test', at: '2026-01-01T00:00:02.000Z' })
    changes.length = 0
    setStatus('waitingForInput')
    await vi.advanceTimersByTimeAsync(900)
    expect(changes).toEqual([])
    await vi.advanceTimersByTimeAsync(200)
    expect(changes).toEqual([{ status: 'waitingForInput', canReceivePrompt: true }])
    conversations.dispose()
  })

  it('keeps the steps of every panel and sends them as they come', async () => {
    const { panels, terminals, prompts, conversation, setStatus, step } = setup()
    setStatus('running')
    const conversations = createAgentConversations({ panels, terminals, prompts, workingMs: 10_000, settleMs: [] })
    const first: AgentStep = { tool: 'Bash', subject: 'npm test', at: '2026-01-01T00:00:01.000Z' }
    step('p1', first)
    const changes: AgentConversationChange[] = []
    let read: AgentConversation | null = null
    conversations.watch('p1', (conversation, change) => {
      if (change) changes.push(change)
      else read = conversation
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(read!.steps).toEqual([first])
    const second: AgentStep = { tool: 'Read', subject: 'src/a.ts', at: '2026-01-01T00:00:02.000Z' }
    step('p1', second)
    expect(changes).toEqual([{ stepsFrom: 1, steps: [second] }])
    expect(conversation).toHaveBeenCalledTimes(1)
    conversations.dispose()
  })

  it('sends the prompts on their way to the agent as they change, without reading the store', async () => {
    const { panels, terminals, prompts, conversation, setStatus } = setup()
    setStatus('running')
    const conversations = createAgentConversations({ panels, terminals, prompts, workingMs: 10_000, settleMs: [] })
    const changes: AgentConversationChange[] = []
    conversations.watch('p1', (_conversation, change) => { if (change) changes.push(change) })
    await vi.advanceTimersByTimeAsync(0)
    const queued = prompts.send('p1', 'next')
    expect(changes).toEqual([{ prompts: [queued] }])
    prompts.withdraw('p1', queued.id)
    expect(changes.at(-1)).toEqual({ prompts: [] })
    expect(conversation).toHaveBeenCalledTimes(1)
    conversations.dispose()
  })

  it('drops the steps of a panel that hosts no agent any more', async () => {
    const { panels, terminals, prompts, setStatus, step, remove } = setup()
    setStatus('running')
    const conversations = createAgentConversations({ panels, terminals, prompts, workingMs: 10_000, settleMs: [] })
    step('p1', { tool: 'Bash', subject: 'npm test', at: '2026-01-01T00:00:01.000Z' })
    remove()
    let read: AgentConversation | null = null
    conversations.watch('p1', (conversation, change) => { if (!change) read = conversation })
    await vi.advanceTimersByTimeAsync(0)
    expect(read!.steps).toEqual([])
    conversations.dispose()
  })

  it('past the kept steps, a new step does not send them all again', async () => {
    const { panels, terminals, prompts, setStatus, step } = setup()
    setStatus('running')
    const conversations = createAgentConversations({ panels, terminals, prompts, workingMs: 10_000, settleMs: [] })
    const changes: AgentConversationChange[] = []
    let read: AgentConversation | null = null
    conversations.watch('p1', (conversation, change) => {
      if (change) changes.push(change)
      else read = conversation
    })
    await vi.advanceTimersByTimeAsync(0)
    const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()
    for (let i = 0; i < 560; i++) step('p1', { tool: 'Bash', subject: `step ${i}`, at: at(i) })
    // Trimmed now and then, never on every step.
    expect(changes.filter((change) => (change.steps?.length ?? 0) > 1).length).toBeLessThanOrEqual(1)
    const steps = changes.reduce((conversation, change) => applyAgentConversationChange(conversation, change), read!).steps
    expect(steps.length).toBeLessThanOrEqual(500)
    expect(steps.at(-1)?.subject).toBe('step 559')
    conversations.dispose()
  })

  it('reads the store only when its stamp moved', async () => {
    const { panels, terminals, prompts, conversation, setStatus } = setup()
    setStatus('running')
    const conversations = createAgentConversations({ panels, terminals, prompts, workingMs: 100, settleMs: [] })
    const stop = conversations.watch('p1', () => {})
    await vi.advanceTimersByTimeAsync(500)
    expect(conversation).toHaveBeenCalledTimes(1)
    stop()
    await vi.advanceTimersByTimeAsync(500)
    expect(conversation).toHaveBeenCalledTimes(1)
  })

  it('clears messages and steps on session rotation before the new transcript exists', async () => {
    const { panels, terminals, prompts, conversation, setStatus, write, step, reset } = setup()
    setStatus('waitingForInput')
    write([{ role: 'user', text: 'old prompt' }, { role: 'assistant', text: 'old reply' }])
    const conversations = createAgentConversations({ panels, terminals, prompts, settleMs: [] })
    const seen: AgentConversation[] = []
    conversations.watch('p1', (next) => seen.push(next))
    await vi.advanceTimersByTimeAsync(0)
    step('p1', { tool: 'Bash', subject: 'old command', at: new Date().toISOString() })
    conversation.mockResolvedValue(null)
    reset()
    setStatus('waitingForInput', { ...session, sessionId: 's2' })
    await vi.advanceTimersByTimeAsync(0)
    expect(seen.at(-1)).toMatchObject({ messages: [], steps: [], status: 'waitingForInput' })

    // Even an unchanged file stamp must read the new session's transcript.
    conversation.mockResolvedValue({ session: { ...session, sessionId: 's3' }, messages: [{ role: 'user', text: 'new prompt' }] })
    reset()
    setStatus('waitingForInput', { ...session, sessionId: 's3' })
    await vi.advanceTimersByTimeAsync(0)
    expect(seen.at(-1)?.messages).toEqual([{ role: 'user', text: 'new prompt' }])
    conversations.dispose()
  })

  it('replaces a same-session conversation and ignores a previous generation read that finishes late', async () => {
    const { panels, terminals, prompts, conversation, setStatus, write, step, reset } = setup()
    setStatus('waitingForInput')
    write([{ role: 'user', text: 'old branch' }])
    const conversations = createAgentConversations({ panels, terminals, prompts, settleMs: [] })
    const seen: AgentConversation[] = []
    conversations.watch('p1', (next) => seen.push(next))
    await vi.advanceTimersByTimeAsync(0)
    step('p1', { tool: 'Bash', subject: 'old tool', at: new Date().toISOString() })
    let finish!: (value: Awaited<ReturnType<typeof conversation>>) => void
    conversation.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    setStatus('running')
    await vi.advanceTimersByTimeAsync(0)
    // Branch changes can have the same session id and the same file stamp.
    reset()
    expect(seen.at(-1)).toMatchObject({ messages: [], steps: [] })
    conversation.mockResolvedValue({ session, messages: [{ role: 'user', text: 'selected branch' }] })
    const afterReset = seen.length
    finish({ session, messages: [{ role: 'user', text: 'late old branch' }] })
    await vi.advanceTimersByTimeAsync(0)
    expect(seen.at(-1)?.messages).toEqual([{ role: 'user', text: 'selected branch' }])
    expect(seen.slice(afterReset).some((next) => next.messages.some((message) => message.text.includes('old branch')))).toBe(false)
    expect(seen.at(-1)?.steps).toEqual([])
    conversations.dispose()
  })
})

describe('conversation changes', () => {
  const base: AgentConversation = {
    generation: 0, status: 'running', canReceivePrompt: false, messages: [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }], steps: [], stepsSince: 'x', prompts: [],
  }

  it('round-trips through apply', () => {
    const next: AgentConversation = {
      ...base,
      status: 'waitingForInput',
      canReceivePrompt: true,
      messages: [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'bc' }, { role: 'user', text: 'd' }],
      steps: [{ tool: 'Bash', at: 't' }],
    }
    const change = diffAgentConversation(base, next)!
    expect(change).toEqual({
      status: 'waitingForInput', canReceivePrompt: true, from: 1, messages: next.messages.slice(1), stepsFrom: 0, steps: next.steps,
    })
    expect(applyAgentConversationChange(base, change)).toEqual(next)
  })

  it('is null for the same conversation, and truncates a shorter one', () => {
    expect(diffAgentConversation(base, { ...base, messages: [...base.messages] })).toBeNull()
    expect(diffAgentConversation(base, { ...base, messages: base.messages.slice(0, 1) })).toEqual({ from: 1, messages: [] })
  })

  it('transports a conversation switch even when the displayed messages are identical', () => {
    const next = { ...base, generation: 1 }
    const change = diffAgentConversation(base, next)!
    expect(change).toEqual({ generation: 1 })
    expect(applyAgentConversationChange(base, change)).toEqual(next)
  })
})

describe('agent steps', () => {
  it('reads what a tool call worked on from any CLI\'s input the same way', () => {
    expect(agentStep({ name: 'Bash', input: { command: 'npm test\nmore' } }, 't')).toEqual({ tool: 'Bash', subject: 'npm test', at: 't' })
    expect(agentStep({ name: 'shell', input: { command: ['git', 'status'] } }, 't')).toEqual({ tool: 'shell', subject: 'git status', at: 't' })
    expect(agentStep({ name: 'read_file', input: { filePath: '/repo/a.ts' } }, 't')).toEqual({ tool: 'read_file', subject: '/repo/a.ts', at: 't' })
    expect(agentStep({ name: ' ', input: 42 }, 't')).toEqual({ tool: 'Tool', at: 't' })
    expect(agentStep({ name: 'Grep', input: { pattern: 'x'.repeat(300) } }, 't').subject).toHaveLength(160)
  })
})
