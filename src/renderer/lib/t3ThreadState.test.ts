import { describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { T3_THREAD_SUBSCRIPTION_SCRIPT, t3ThreadActivity, t3ThreadPollScript } from './t3ThreadState'

describe('T3 conversation state', () => {
  it('distinguishes waiting, active turns, background work, and completed conversations', () => {
    const thread = { id: 'a', title: 'A' }
    expect(t3ThreadActivity(thread)).toBe('notRunning')
    expect(t3ThreadActivity({ ...thread, latestTurn: { state: 'completed' } })).toBe('waitingForInput')
    expect(t3ThreadActivity({ ...thread, latestTurn: { state: 'running' } })).toBe('running')
    expect(t3ThreadActivity({ ...thread, backgroundLiveness: 'monitoring' })).toBe('running')
    expect(t3ThreadActivity({ ...thread, latestTurn: { state: 'running' }, hasPendingApprovals: true })).toBe('waitingForInput')
    expect(t3ThreadActivity({ ...thread, hasPendingUserInput: true })).toBe('waitingForInput')
  })

  it.each(['completed', 'interrupted', 'error'])('waits for input after a %s turn unless work continues', (state) => {
    const thread = { id: 'a', title: 'A', latestTurn: { state } }
    expect(t3ThreadActivity(thread)).toBe('waitingForInput')
    expect(t3ThreadActivity({ ...thread, backgroundLiveness: 'working' })).toBe('running')
    expect(t3ThreadActivity({ ...thread, session: { status: 'ready', activeTurnId: 'next' } })).toBe('running')
  })

  it('subscribes once, tracks multiple conversations, and clears connectivity on disconnect', () => {
    let socket: any
    class FakeSocket {
      send = vi.fn()
      close = vi.fn()
      constructor() { socket = this }
    }
    const window: any = { addEventListener: vi.fn() }
    const context = { window, WebSocket: FakeSocket, location: { origin: 'http://127.0.0.1:1234' }, setTimeout: vi.fn(), clearTimeout: vi.fn() }
    runInNewContext(T3_THREAD_SUBSCRIPTION_SCRIPT, context)
    socket.onopen()
    expect(JSON.parse(socket.send.mock.calls[0][0]).tag).toBe('orchestration.subscribeShell')
    const emit = (event: unknown) => socket.onmessage({ data: JSON.stringify({ _tag: 'Chunk', requestId: 'cate-shell', values: [event] }) })
    emit({ kind: 'snapshot', snapshot: { threads: [{ id: 'a', title: 'First' }, { id: 'b', title: 'Second' }] } })
    emit({ kind: 'thread-upserted', thread: { id: 'b', title: 'Generated title', latestTurn: { state: 'running' } } })
    expect(window.__cateT3Threads.threads.a.title).toBe('First')
    expect(window.__cateT3Threads.threads.b.title).toBe('Generated title')
    expect(window.__cateT3Threads.connected).toBe(true)
    expect(JSON.parse(socket.send.mock.calls.at(-1)[0])).toEqual({ _tag: 'Ack', requestId: 'cate-shell' })
    const firstSocket = socket
    runInNewContext(T3_THREAD_SUBSCRIPTION_SCRIPT, context)
    expect(socket).toBe(firstSocket)
    emit({ kind: 'thread-removed', threadId: 'a' })
    expect(window.__cateT3Threads.threads.a).toBeUndefined()
    socket.onclose()
    expect(window.__cateT3Threads.connected).toBe(false)
    expect(context.setTimeout).toHaveBeenCalled()
  })
})


it('copies thread metadata only when changed and can force a fresh read', () => {
  const state = { connected: true, revision: 7, sequence: 12, threads: { a: { id: 'a', title: 'First' } } }
  const context = { window: { __cateT3Threads: state } }
  expect(runInNewContext(t3ThreadPollScript(), context)).toEqual(state)
  expect(runInNewContext(t3ThreadPollScript(7), context)).toBeUndefined()
  state.threads.a.title = 'Updated'
  state.revision++
  expect(runInNewContext(t3ThreadPollScript(7), context)).toEqual(state)
  expect(runInNewContext(t3ThreadPollScript(8), context)).toBeUndefined()
  // Disconnects must still reach the host, even with unchanged thread content.
  state.connected = false
  state.revision++
  expect(runInNewContext(t3ThreadPollScript(8), context)?.connected).toBe(false)
  expect(runInNewContext(t3ThreadPollScript(), context)).toEqual(state)
})

it('installs a single subscription when polling an uninitialized guest', () => {
  const sockets = vi.fn()
  class FakeSocket { constructor() { sockets() } }
  const context = {
    window: { addEventListener: vi.fn() }, WebSocket: FakeSocket,
    location: { origin: 'http://127.0.0.1:1234' },
  }
  expect(runInNewContext(t3ThreadPollScript(), context)?.revision).toBe(0)
  for (let i = 0; i < 20; i++) expect(runInNewContext(t3ThreadPollScript(0), context)).toBeUndefined()
  expect(sockets).toHaveBeenCalledOnce()
})
