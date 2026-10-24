import { afterEach, expect, it, vi } from 'vitest'
import { setRuntimeResolver } from '@kernel/rpc/client'
import type { ChannelEvent } from '@kernel/rpc/contract'
import type { AgentConversation, AgentConversationChange, AgentPrompt } from '../contract'
import { watchAgentChat } from './conversation'
import { fakeStream } from './testing'

type ConversationEvent = ChannelEvent<AgentConversation, AgentConversationChange>

const conversation = (patch: Partial<AgentConversation> = {}): AgentConversation => ({
  status: 'waitingForInput', canReceivePrompt: true, messages: [], steps: [], stepsSince: '2026-01-01T00:00:00.000Z', prompts: [], ...patch,
})

let stop = () => {}
const chats: ReturnType<typeof watchAgentChat>[] = []
afterEach(() => {
  for (const chat of chats.splice(0)) chat.release()
  stop()
})

it('shows the conversation with the prompts the runtime keeps, and sends nothing itself', () => {
  const stream = fakeStream<ConversationEvent>()
  const send = vi.fn()
  const runtime = { agents: { conversation: vi.fn(() => stream.sub), send } }
  stop = setRuntimeResolver((id) => (id === 'ws' ? (runtime as never) : null))
  const chat = watchAgentChat('ws', 'p1')
  chats.push(chat)
  expect(chat.get()).toBeNull()

  const queued: AgentPrompt = { id: 'q1', text: 'next', attachments: [], state: 'queued' }
  stream.emit({ kind: 'snapshot', rev: 1, snapshot: conversation({
    status: 'running',
    canReceivePrompt: false,
    messages: [{ role: 'user', text: 'Complete this coding task:\n\nSay hi' }],
    prompts: [queued],
  }) })
  expect(chat.get()).toMatchObject({ messages: [{ role: 'user', text: 'Say hi' }], prompts: [queued] })

  // The agent can take it: the runtime sends it, the chat only follows.
  const sending: AgentPrompt = { ...queued, state: 'sending' }
  stream.emit({ kind: 'change', rev: 2, change: { status: 'waitingForInput', canReceivePrompt: true, prompts: [sending] } })
  expect(chat.get()?.prompts).toEqual([sending])
  stream.emit({ kind: 'change', rev: 3, change: { status: 'running', canReceivePrompt: false, prompts: [] } })
  expect(chat.get()?.prompts).toEqual([])
  expect(send).not.toHaveBeenCalled()
})
