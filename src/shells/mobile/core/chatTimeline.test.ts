import { describe, expect, it } from 'vitest'
import type { AgentChat } from '@services/agents/client'
import type { AgentConversation, AgentConversationMessage, AgentStatus, AgentStep } from '@services/agents/contract'
import { TAKE_UP_MS, createChatTimeline } from './chatTimeline'

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString()
const user = (text: string, second: number): AgentConversationMessage => ({ role: 'user', text, createdAt: at(second) })
const reply = (text: string, second: number): AgentConversationMessage => ({ role: 'assistant', text, createdAt: at(second) })
const step = (tool: string, second: number): AgentStep => ({ tool, at: at(second) })

function chat(status: AgentStatus | null, messages: AgentConversationMessage[], extra: Partial<AgentChat & AgentConversation> = {}): AgentChat {
  const conversation: AgentConversation = {
    status, canReceivePrompt: status === 'waitingForInput', messages, steps: extra.steps ?? [], stepsSince: at(0),
  }
  return { conversation, pending: extra.pending ?? null, queued: extra.queued ?? null }
}

describe('chat timeline', () => {
  it('is not loaded before the conversation was read, and a first prompt opens its turn', () => {
    const timeline = createChatTimeline()
    expect(timeline.update({ conversation: null, pending: null, queued: null }, 0).chat).toMatchObject({ loaded: false, turn: null, items: [] })
    expect(timeline.update({ conversation: null, pending: 'go', queued: null }, 1).chat).toMatchObject({
      loaded: false, turn: { step: null }, items: [{ kind: 'prompt', id: 'm0', text: 'go', sent: false }],
    })
  })

  it('keeps a sent prompt under one id and its turn open from sending to the reply', () => {
    const timeline = createChatTimeline()
    const history = [user('hi', 1), reply('Hello.', 2)]
    timeline.update(chat('waitingForInput', history), 0)
    const sending = timeline.update(chat('waitingForInput', history, { pending: 'fix it' }), 10).chat
    expect(sending.items.at(-1)).toEqual({ kind: 'prompt', id: 'm2', text: 'fix it', sent: false })
    expect(sending.turn).toEqual({ step: null })

    // The prompt shows before the agent said it took it up: still open.
    const shown = timeline.update(chat('waitingForInput', [...history, user('fix it', 3)]), 20)
    expect(shown.chat.items.at(-1)).toEqual({ kind: 'prompt', id: 'm2', text: 'fix it', sent: true })
    expect(shown.chat.turn).toEqual({ step: null })
    expect(shown.recheckAt).toBe(20 + TAKE_UP_MS)

    const working = timeline.update(chat('running', [...history, user('fix it', 3)]), 30)
    expect(working.chat.turn).toEqual({ step: null })
    expect(working.recheckAt).toBeNull()

    const done = timeline.update(chat('waitingForInput', [...history, user('fix it', 3), reply('Fixed.', 9)]), 40).chat
    expect(done.turn).toBeNull()
    expect(done.items.map((item) => item.id)).toEqual(['m0', 'm1', 'm2', 'm3'])
  })

  it('closes a turn the agent never took up once its take-up ran out', () => {
    const timeline = createChatTimeline()
    timeline.update(chat('waitingForInput', [], { pending: 'go' }), 0)
    expect(timeline.update(chat('waitingForInput', [user('go', 1)]), 100).chat.turn).not.toBeNull()
    expect(timeline.update(chat('waitingForInput', [user('go', 1)]), 100 + TAKE_UP_MS).chat.turn).toBeNull()
  })

  it('a prompt that did not go through closes its turn at once', () => {
    const timeline = createChatTimeline()
    timeline.update(chat('waitingForInput', [], { pending: 'go' }), 0)
    const back = timeline.update(chat('waitingForInput', []), 10)
    expect(back.chat.turn).toBeNull()
    expect(back.chat.items).toEqual([])
  })

  it('shows the running turn\'s last step at its end as what the agent does', () => {
    const timeline = createChatTimeline()
    const view = timeline.update(chat('running', [user('go', 1)], { steps: [step('Read', 2), step('Bash', 3)] }), 0).chat
    expect(view.items).toEqual([
      { kind: 'prompt', id: 'm0', text: 'go', sent: true },
      { kind: 'steps', id: 's1', steps: [step('Read', 2), step('Bash', 3)], ghost: false },
    ])
    expect(view.turn).toEqual({ step: step('Bash', 3) })
    // A reply after it: working on, no step to show.
    expect(timeline.update(chat('running', [user('go', 1), reply('Done?', 4)], { steps: [step('Read', 2), step('Bash', 3)] }), 1).chat.turn)
      .toEqual({ step: null })
  })

  it('leaves steps on screen where they are when a message dated before them is read late', () => {
    const timeline = createChatTimeline()
    const steps = [step('Read', 2), step('Bash', 4)]
    timeline.update(chat('running', [user('go', 1)], { steps }), 0)
    // Written at 3, between the steps, read only now.
    const late = timeline.update(chat('running', [user('go', 1), reply('Looking.', 3)], { steps: [...steps, step('Edit', 5)] }), 1).chat
    expect(late.items.map((item) => item.id)).toEqual(['m0', 's1', 'm1', 's2'])
    expect(late.items[1]).toMatchObject({ steps })
    expect(late.items[3]).toMatchObject({ steps: [step('Edit', 5)] })
  })

  it('shows a ghost where steps ran before the runtime kept them', () => {
    const timeline = createChatTimeline()
    const conversation: AgentConversation = {
      status: 'waitingForInput', canReceivePrompt: true, messages: [user('go', 1), reply('Done.', 30)], steps: [], stepsSince: at(200),
    }
    expect(timeline.update({ conversation, pending: null, queued: null }, 0).chat.items[1])
      .toEqual({ kind: 'steps', id: 's1', steps: [], ghost: true })
  })
})
