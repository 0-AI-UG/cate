import { describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { T3_THREAD_SUBSCRIPTION_SCRIPT, t3ThreadActivity } from './t3ThreadState'

describe('T3 conversation state', () => {
  it('distinguishes waiting, active turns, background work, and completed conversations', () => {
    const thread = { id: 'a', title: 'A' }
    expect(t3ThreadActivity(thread)).toBe('notRunning')
    expect(t3ThreadActivity({ ...thread, latestTurn: { state: 'completed' } })).toBe('finished')
    expect(t3ThreadActivity({ ...thread, latestTurn: { state: 'running' } })).toBe('running')
    expect(t3ThreadActivity({ ...thread, backgroundLiveness: 'monitoring' })).toBe('running')
    expect(t3ThreadActivity({ ...thread, latestTurn: { state: 'running' }, hasPendingApprovals: true })).toBe('waitingForInput')
    expect(t3ThreadActivity({ ...thread, hasPendingUserInput: true })).toBe('waitingForInput')
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
