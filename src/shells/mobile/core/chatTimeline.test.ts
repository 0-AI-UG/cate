import { describe, expect, it } from 'vitest'
import type { AgentConversation, AgentConversationMessage, AgentPrompt, AgentStatus, AgentStep } from '@services/agents/contract'
import { NOT_TAKEN, createChatTimeline } from './chatTimeline'

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString()
const user = (text: string, second: number): AgentConversationMessage => ({ role: 'user', text, createdAt: at(second) })
const reply = (text: string, second: number): AgentConversationMessage => ({ role: 'assistant', text, createdAt: at(second) })
const step = (tool: string, second: number): AgentStep => ({ tool, at: at(second) })
const prompt = (id: string, text: string, state: AgentPrompt['state'], attachments: string[] = []): AgentPrompt => ({ id, text, attachments, state })

function chat(status: AgentStatus | null, messages: AgentConversationMessage[], extra: Partial<AgentConversation> = {}): AgentConversation {
  return { status, canReceivePrompt: status === 'waitingForInput', messages, steps: [], stepsSince: at(0), prompts: [], ...extra }
}

describe('chat timeline', () => {
  it('is not loaded before the conversation was read, and a new agent\'s first prompt opens its turn', () => {
    expect(createChatTimeline().update(null)).toMatchObject({ loaded: false, turn: null, items: [], queued: [], failed: [] })
    const timeline = createChatTimeline('go')
    expect(timeline.update(null)).toMatchObject({
      loaded: false, turn: { step: null }, items: [{ kind: 'prompt', id: 'm0', text: 'go', sent: false }],
    })
    // Until the conversation has a prompt of the person's, whatever its text.
    expect(timeline.update(chat('running', [])).items).toEqual([{ kind: 'prompt', id: 'm0', text: 'go', sent: false }])
    expect(timeline.update(chat('running', [user('[Image #1] go', 1)])).items).toEqual([{ kind: 'prompt', id: 'm0', text: '[Image #1] go', sent: true }])
  })

  it('keeps a prompt being sent under one id and its turn open from sending to the reply', () => {
    const timeline = createChatTimeline()
    const history = [user('hi', 1), reply('Hello.', 2)]
    timeline.update(chat('waitingForInput', history))
    const sending = timeline.update(chat('waitingForInput', history, { prompts: [prompt('a', 'fix it', 'sending')] }))
    expect(sending.items.at(-1)).toEqual({ kind: 'prompt', id: 'm2', text: 'fix it', sent: false })
    expect(sending.turn).toEqual({ step: null })

    // Taken: the runtime let go of it before the store shows it; it stays.
    expect(timeline.update(chat('running', history)).items.at(-1)).toEqual({ kind: 'prompt', id: 'm2', text: 'fix it', sent: false })

    // The store shows it, as the agent wrote it: the same item, sent.
    const shown = timeline.update(chat('running', [...history, user('[Image #1] fix it', 3)]))
    expect(shown.items.at(-1)).toEqual({ kind: 'prompt', id: 'm2', text: '[Image #1] fix it', sent: true })
    expect(shown.turn).toEqual({ step: null })

    const done = timeline.update(chat('waitingForInput', [...history, user('fix it', 3), reply('Fixed.', 9)]))
    expect(done.turn).toBeNull()
    expect(done.items.map((item) => item.id)).toEqual(['m0', 'm1', 'm2', 'm3'])
  })

  it('keeps showing a taken prompt until the conversation has a new message, however long it takes', () => {
    const timeline = createChatTimeline()
    timeline.update(chat('waitingForInput', [], { prompts: [prompt('a', 'go', 'sending')] }))
    for (let i = 0; i < 3; i++) {
      expect(timeline.update(chat('waitingForInput', [])).items).toEqual([{ kind: 'prompt', id: 'm0', text: 'go', sent: false }])
    }
    expect(timeline.update(chat('waitingForInput', [user('go', 1)])).items).toEqual([{ kind: 'prompt', id: 'm0', text: 'go', sent: true }])
  })

  it('shows prompts not taken as failed, and the queued ones in order, as the runtime keeps them', () => {
    const timeline = createChatTimeline()
    timeline.update(chat('waitingForInput', [], { prompts: [prompt('a', 'go', 'sending')] }))
    const failed = timeline.update(chat('waitingForInput', [], {
      prompts: [prompt('a', 'go', 'failed'), prompt('b', '', 'queued', ['/data/photo.jpg']), prompt('c', 'then', 'queued')],
    }))
    expect(failed.items).toEqual([])
    expect(failed.turn).toBeNull()
    expect(failed.failed).toEqual([{ id: 'a', text: 'go', message: NOT_TAKEN }])
    expect(failed.queued).toEqual([{ id: 'b', text: 'See the attached files.' }, { id: 'c', text: 'then' }])
  })

  it('shows the running turn\'s last step at its end as what the agent does', () => {
    const timeline = createChatTimeline()
    const view = timeline.update(chat('running', [user('go', 1)], { steps: [step('Read', 2), step('Bash', 3)] }))
    expect(view.items).toEqual([
      { kind: 'prompt', id: 'm0', text: 'go', sent: true },
      { kind: 'steps', id: 's1', steps: [step('Read', 2), step('Bash', 3)], ghost: false },
    ])
    expect(view.turn).toEqual({ step: step('Bash', 3) })
    // A reply after it: working on, no step to show.
    expect(timeline.update(chat('running', [user('go', 1), reply('Done?', 4)], { steps: [step('Read', 2), step('Bash', 3)] })).turn)
      .toEqual({ step: null })
  })

  it('leaves steps on screen where they are when a message dated before them is read late', () => {
    const timeline = createChatTimeline()
    const steps = [step('Read', 2), step('Bash', 4)]
    timeline.update(chat('running', [user('go', 1)], { steps }))
    // Written at 3, between the steps, read only now.
    const late = timeline.update(chat('running', [user('go', 1), reply('Looking.', 3)], { steps: [...steps, step('Edit', 5)] }))
    expect(late.items.map((item) => item.id)).toEqual(['m0', 's1', 'm1', 's2'])
    expect(late.items[1]).toMatchObject({ steps })
    expect(late.items[3]).toMatchObject({ steps: [step('Edit', 5)] })
  })

  it('shows a ghost where steps ran before the runtime kept them', () => {
    const timeline = createChatTimeline()
    const conversation = chat('waitingForInput', [user('go', 1), reply('Done.', 30)], { stepsSince: at(200) })
    expect(timeline.update(conversation).items[1])
      .toEqual({ kind: 'steps', id: 's1', steps: [], ghost: true })
  })
})
