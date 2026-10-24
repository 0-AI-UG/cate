import { describe, expect, it } from 'vitest'
import type { AgentConversation, AgentStep } from './conversation'
import { agentStepGroups } from './steps'

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString()
const step = (tool: string, second: number): AgentStep => ({ tool, at: at(second) })

function conversation(overrides: Partial<AgentConversation>): AgentConversation {
  return { status: 'waitingForInput', canReceivePrompt: true, messages: [], steps: [], stepsSince: at(0), prompts: [], ...overrides }
}

describe('agent step groups', () => {
  const messages: AgentConversation['messages'] = [
    { role: 'user', text: 'one', createdAt: at(10) },
    { role: 'assistant', text: 'looking', createdAt: at(11) },
    { role: 'assistant', text: 'done', createdAt: at(15) },
    { role: 'user', text: 'two', createdAt: at(20) },
    { role: 'assistant', text: 'ok', createdAt: at(25) },
  ]

  it('puts each turn\'s steps before its final reply', () => {
    const groups = agentStepGroups(conversation({ messages, steps: [step('Read', 12), step('Edit', 13), step('Bash', 22)] }))
    expect(groups).toEqual([
      { before: 2, steps: [step('Read', 12), step('Edit', 13)], ghost: false },
      { before: 4, steps: [step('Bash', 22)], ghost: false },
    ])
  })

  it('puts steps between the replies they came between', () => {
    const groups = agentStepGroups(conversation({ messages, steps: [step('Read', 10), step('Grep', 10), step('Edit', 13)] }))
    expect(groups).toEqual([
      { before: 1, steps: [step('Read', 10), step('Grep', 10)], ghost: false },
      { before: 2, steps: [step('Edit', 13)], ghost: false },
    ])
  })

  it('puts the running turn\'s steps at its end and names its last one', () => {
    const running = conversation({ status: 'running', messages: messages.slice(0, 4), steps: [step('Read', 21), step('Bash', 22)] })
    expect(agentStepGroups(running)).toEqual([{ before: 4, steps: [step('Read', 21), step('Bash', 22)], ghost: false }])
  })

  it('shows a ghost for an answered turn from before steps were kept', () => {
    const groups = agentStepGroups(conversation({ messages, stepsSince: at(75), steps: [step('Bash', 22)] }))
    expect(groups).toEqual([
      { before: 2, steps: [], ghost: true },
      { before: 4, steps: [step('Bash', 22)], ghost: false },
    ])
  })

  it('has no ghost for a prompt dated within a minute of when steps were kept', () => {
    // A store that dates prompts to the minute (Cursor) puts a prompt sent
    // just after the runtime started up to a minute before it.
    expect(agentStepGroups(conversation({ messages: messages.slice(0, 3), stepsSince: at(50) }))).toEqual([])
  })

  it('puts steps in a minute-dated turn after its prompt', () => {
    const minute = [{ role: 'user' as const, text: 'one', createdAt: at(0) }, { role: 'assistant' as const, text: 'done', createdAt: at(0) }]
    expect(agentStepGroups(conversation({ messages: minute, steps: [step('Read', 42)] }))).toEqual([
      { before: 1, steps: [step('Read', 42)], ghost: false },
    ])
  })

  it('has no ghost for a turn kept without steps', () => {
    expect(agentStepGroups(conversation({ messages }))).toEqual([])
  })

  it('reads a prompt without a time as starting with the turn before', () => {
    const undated = messages.map((message) => message.text === 'two' ? { role: message.role, text: message.text } : message)
    expect(agentStepGroups(conversation({ messages: undated, steps: [step('Bash', 22)] }))).toEqual([
      { before: 4, steps: [step('Bash', 22)], ghost: false },
    ])
  })
})
