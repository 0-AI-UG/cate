import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import type { AddressInfo } from 'net'
import type { T3ShellSnapshot } from '../contract'
import { ThreadShellSubscription } from './threadShells'

let server: WebSocketServer | undefined
let subscription: ThreadShellSubscription | undefined
afterEach(() => { subscription?.stop(); server?.close() })

async function harness(): Promise<{ url: string; next: () => Promise<{ socket: WebSocket; request: Record<string, unknown>; cookie?: string }> }> {
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise((resolve) => server!.once('listening', resolve))
  const pending: Array<(value: { socket: WebSocket; request: Record<string, unknown>; cookie?: string }) => void> = []
  server.on('connection', (socket, request) => socket.once('message', (data: { toString(): string }) => {
    pending.shift()?.({ socket, request: JSON.parse(data.toString()), cookie: request.headers.cookie })
  }))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    next: () => new Promise((resolve) => pending.push(resolve)),
  }
}

describe('ThreadShellSubscription', () => {
  it('subscribes with the harness cookie, folds shell events into full snapshots, and acks chunks', async () => {
    const { url, next } = await harness()
    const published: T3ShellSnapshot[] = []
    const connection = next()
    subscription = new ThreadShellSubscription(
      { instanceId: 'i1', checkout: '/repo', url, cookie: 'session=abc', alive: () => true },
      (snapshot) => published.push(snapshot),
    )
    const { socket, request, cookie } = await connection
    expect(cookie).toBe('session=abc')
    expect(request).toMatchObject({ _tag: 'Request', tag: 'orchestration.subscribeShell' })
    const acks: unknown[] = []
    socket.on('message', (data: { toString(): string }) => acks.push(JSON.parse(data.toString())))
    const chunk = (...values: unknown[]) => socket.send(JSON.stringify({ _tag: 'Chunk', requestId: request.id, values }))
    chunk({ kind: 'snapshot', snapshot: { snapshotSequence: 4, threads: [
      { id: 'a', title: 'A', session: { status: 'ready', activeTurnId: null, providerName: 'codex' }, extra: 'dropped' },
      { id: 'b', title: 'B' },
    ] } })
    chunk({ kind: 'thread-upserted', sequence: 5, thread: { id: 'b', title: 'Renamed', latestTurn: { state: 'running' } } }, { kind: 'thread-removed', sequence: 6, threadId: 'a' })
    await vi.waitFor(() => expect(published.at(-1)?.sequence).toBe(6))
    expect(published.at(-1)).toMatchObject({ instanceId: 'i1', checkout: '/repo', connected: true, threads: { b: { id: 'b', title: 'Renamed', latestTurn: { state: 'running' } } } })
    expect(Object.keys(published.at(-1)!.threads)).toEqual(['b'])
    await vi.waitFor(() => expect(acks).toContainEqual({ _tag: 'Ack', requestId: request.id }))
  })

  it('reports a dropped stream as disconnected and reconnects only while the harness is alive', async () => {
    const { url, next } = await harness()
    const published: T3ShellSnapshot[] = []
    let alive = true
    const first = next()
    subscription = new ThreadShellSubscription({ instanceId: 'p', checkout: '/repo', url, cookie: '', alive: () => alive }, (s) => published.push(s))
    const { socket, request } = await first
    socket.send(JSON.stringify({ _tag: 'Chunk', requestId: request.id, values: [{ kind: 'snapshot', snapshot: { snapshotSequence: 1, threads: [] } }] }))
    await vi.waitFor(() => expect(published.at(-1)?.connected).toBe(true))
    const second = next()
    socket.close()
    await vi.waitFor(() => expect(published.at(-1)?.connected).toBe(false))
    await second
    alive = false
    subscription.stop()
    expect(published.at(-1)?.connected).toBe(false)
  }, 10_000)

  it('does not reconnect when the harness dies after the stream dropped', async () => {
    const { url, next } = await harness()
    const published: T3ShellSnapshot[] = []
    let alive = true
    let connections = 0
    server!.on('connection', () => { connections++ })
    const first = next()
    subscription = new ThreadShellSubscription({ instanceId: 'p', checkout: '/repo', url, cookie: '', alive: () => alive }, (s) => published.push(s))
    const { socket, request } = await first
    socket.send(JSON.stringify({ _tag: 'Chunk', requestId: request.id, values: [{ kind: 'snapshot', snapshot: { snapshotSequence: 1, threads: [] } }] }))
    await vi.waitFor(() => expect(published.at(-1)?.connected).toBe(true))
    socket.close()
    await vi.waitFor(() => expect(published.at(-1)?.connected).toBe(false))
    // The server-exit callback lands after the socket close.
    alive = false
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    expect(connections).toBe(1)
  }, 10_000)
})
