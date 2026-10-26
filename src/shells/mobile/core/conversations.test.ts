import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setRuntimeResolver } from '@kernel/rpc/client'
import type { ChannelEvent } from '@kernel/rpc/contract'
import { fakeStream } from '@services/agents/client/testing'
import type { AgentConversation, AgentConversationChange, AgentConversationMessage } from '@services/agents/contract'
import type { MobileBridge, MobileViewEvent } from '../contract'
import { CHAT_PAGE, createMobileConversations } from './conversations'

type ChatEvent = Extract<MobileViewEvent, { kind: 'chat' }>

let conversation: ReturnType<typeof fakeStream<ChannelEvent<AgentConversation, AgentConversationChange>>>
let events: ChatEvent[]
let stopResolver: () => void

beforeEach(() => {
  conversation = fakeStream()
  events = []
  const runtime = { agents: { panels: () => fakeStream().sub, conversation: vi.fn(() => conversation.sub) } }
  stopResolver = setRuntimeResolver((id) => (id === 'ws' ? (runtime as never) : null))
})

afterEach(() => stopResolver())

const bridge = (async (method: string, params: { json: string }) => {
  if (method === 'view.event') events.push(JSON.parse(params.json) as ChatEvent)
  return null
}) as MobileBridge

/** `count` messages, prompts and replies taking turns. */
const messages = (count: number, from = 0): AgentConversationMessage[] => Array.from({ length: count }, (_, i) => (from + i) % 2 === 0
  ? { role: 'user', text: `prompt ${from + i}`, createdAt: `2026-01-01T00:00:${String(from + i).padStart(2, '0')}.000Z` }
  : { role: 'assistant', text: `reply ${from + i}` })

const load = (all: AgentConversationMessage[], steps: AgentConversation['steps'] = []) => conversation.emit({ kind: 'snapshot', rev: 0, snapshot: {
  status: 'waitingForInput', canReceivePrompt: true, messages: all, steps, stepsSince: '2026-01-01T00:00:00.000Z', prompts: [],
} })

const ids = (event: ChatEvent | undefined) => event?.items.map((item) => item.id)
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `m${from + i}`)

it('opens a long chat with its latest page and adds earlier pages as asked, sending each item once', () => {
  const chats = createMobileConversations(bridge)
  chats.watch({ viewId: 'v', workspaceId: 'ws', panelId: 'p1' })
  events.length = 0
  load(messages(50))

  // Only the latest page goes to the app.
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ loaded: true, from: 0, earlier: true })
  expect(ids(events[0])).toEqual(range(50 - CHAT_PAGE, 50))

  // What comes in is added at the end; nothing shown is sent again.
  conversation.emit({ kind: 'change', rev: 1, change: { from: 50, messages: messages(1, 50) } })
  expect(events.at(-1)).toMatchObject({ from: CHAT_PAGE, earlier: true })
  expect(ids(events.at(-1))).toEqual(['m50'])

  // Scrolled up: the page before, with everything after it.
  chats.more('v')
  expect(events.at(-1)).toMatchObject({ from: 0, earlier: true })
  expect(ids(events.at(-1))).toEqual(range(50 - 2 * CHAT_PAGE, 51))

  // The first page: nothing is left before it.
  chats.more('v')
  expect(events.at(-1)).toMatchObject({ from: 0, earlier: false })
  expect(ids(events.at(-1))).toEqual(range(0, 51))

  const sent = events.length
  chats.more('v')
  expect(events).toHaveLength(sent)
  chats.unwatch('v')
})

it('shows a short chat whole', () => {
  const chats = createMobileConversations(bridge)
  chats.watch({ viewId: 'v', workspaceId: 'ws', panelId: 'p1' })
  events.length = 0
  load(messages(4))
  expect(events.at(-1)).toMatchObject({ from: 0, earlier: false })
  expect(ids(events.at(-1))).toEqual(range(0, 4))
  chats.more('v')
  expect(events).toHaveLength(1)
  chats.unwatch('v')
})

it('starts a page with the steps of its first message', () => {
  const chats = createMobileConversations(bridge)
  chats.watch({ viewId: 'v', workspaceId: 'ws', panelId: 'p1' })
  // The page starts at a reply: the steps of its turn show before it.
  const first = 31 - CHAT_PAGE
  const all = messages(31)
  load(all, [{ tool: 'Bash', subject: 'npm test', at: (all[first - 1] as { createdAt: string }).createdAt.replace('.000Z', '.500Z') }])
  expect(ids(events.at(-1))).toEqual([`s${first}`, ...range(first, 31)])
  chats.unwatch('v')
})

it('opens again on the latest page when the conversation got shorter', () => {
  const chats = createMobileConversations(bridge)
  chats.watch({ viewId: 'v', workspaceId: 'ws', panelId: 'p1' })
  events.length = 0
  load(messages(50))
  conversation.emit({ kind: 'snapshot', rev: 1, snapshot: {
    status: 'waitingForInput', canReceivePrompt: true, messages: messages(3), steps: [], stepsSince: '2026-01-01T00:00:00.000Z', prompts: [],
  } })
  expect(events.at(-1)).toMatchObject({ from: 0, earlier: false })
  expect(ids(events.at(-1))).toEqual(range(0, 3))
  chats.unwatch('v')
})
