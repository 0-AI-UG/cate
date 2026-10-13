import { afterEach, expect, it, vi } from 'vitest'
import { setRuntimeResolver } from '@kernel/rpc/client'
import type { ChannelEvent } from '@kernel/rpc/contract'
import type { AgentConversation, AgentConversationChange } from '../contract'
import { watchAgentChat } from './conversation'
import { fakeStream } from './testing'

type ConversationEvent = ChannelEvent<AgentConversation, AgentConversationChange>

const conversation = (patch: Partial<AgentConversation> = {}): AgentConversation => ({
  status: null, canReceivePrompt: true, messages: [], steps: [], stepsSince: null, ...patch,
} as AgentConversation)

let stop = () => {}
const chats: ReturnType<typeof watchAgentChat>[] = []
afterEach(() => {
  for (const chat of chats.splice(0)) chat.release()
  stop()
})
const watch = () => {
  const chat = watchAgentChat('ws', 'p1')
  chats.push(chat)
  return chat
}

it('does not send a queued prompt again when the agent took it but the send failed', async () => {
  const stream = fakeStream<ConversationEvent>()
  let reject = (_: Error) => {}
  const send = vi.fn(() => new Promise((_, r) => { reject = r }))
  const runtime = { agents: { conversation: vi.fn(() => stream.sub), send } }
  stop = setRuntimeResolver((id) => (id === 'ws' ? (runtime as never) : null))
  const chat = watch()
  stream.emit({ kind: 'snapshot', rev: 1, snapshot: conversation() })

  chat.queue('hello')
  expect(send).toHaveBeenCalledTimes(1)
  // The agent takes it and starts working...
  const asked = { role: 'user', text: 'hello', createdAt: '1' } as AgentConversation['messages'][number]
  stream.emit({ kind: 'change', rev: 2, change: { canReceivePrompt: false, from: 0, messages: [asked] } })
  expect(chat.get().pending).toBeNull()
  // ...but its turn-start came too late: the send reports a failure.
  reject(new Error('agent-prompt-not-taken'))
  await Promise.resolve()
  await Promise.resolve()
  expect(chat.get().queued).toBeNull()
  // The turn ends; nothing goes out a second time.
  const reply = { role: 'assistant', text: 'hi', createdAt: '2' } as AgentConversation['messages'][number]
  stream.emit({ kind: 'change', rev: 3, change: { canReceivePrompt: true, from: 1, messages: [reply] } })
  expect(send).toHaveBeenCalledTimes(1)
})

it('queues a prompt again when the send failed and the agent never took it', async () => {
  const stream = fakeStream<ConversationEvent>()
  const send = vi.fn().mockRejectedValueOnce(new Error('agent-busy')).mockResolvedValue({ ok: true })
  const runtime = { agents: { conversation: vi.fn(() => stream.sub), send } }
  stop = setRuntimeResolver((id) => (id === 'ws' ? (runtime as never) : null))
  const chat = watch()
  stream.emit({ kind: 'snapshot', rev: 1, snapshot: conversation() })

  chat.queue('hello')
  await vi.waitFor(() => expect(chat.get().queued).toBe('hello'))
  expect(chat.get().pending).toBeNull()
  stream.emit({ kind: 'change', rev: 2, change: { canReceivePrompt: true } })
  expect(send).toHaveBeenCalledTimes(2)
})

it('drops a prompt queued again once the conversation shows the agent took it after all', async () => {
  const stream = fakeStream<ConversationEvent>()
  const send = vi.fn().mockRejectedValue(new Error('agent-prompt-not-taken'))
  const runtime = { agents: { conversation: vi.fn(() => stream.sub), send } }
  stop = setRuntimeResolver((id) => (id === 'ws' ? (runtime as never) : null))
  const chat = watch()
  stream.emit({ kind: 'snapshot', rev: 1, snapshot: conversation() })

  chat.queue('hello')
  await vi.waitFor(() => expect(chat.get().queued).toBe('hello'))
  // The transcript catches up while the agent works, then the turn ends.
  const asked = { role: 'user', text: 'hello', createdAt: '1' } as AgentConversation['messages'][number]
  stream.emit({ kind: 'change', rev: 2, change: { canReceivePrompt: false, from: 0, messages: [asked] } })
  stream.emit({ kind: 'change', rev: 3, change: { canReceivePrompt: true } })
  expect(chat.get().queued).toBeNull()
  expect(send).toHaveBeenCalledTimes(1)
})
