import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { connectWebSocketFactory } from './webSocket'

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    default: vi.fn(class extends EventEmitter {
      ping = vi.fn()
      terminate = vi.fn(() => this.emit('close'))
    }),
  }
})

function socket() {
  connectWebSocketFactory('wss://connect.test/runtime')
  return vi.mocked(WebSocket).mock.results.at(-1)!.value as {
    emit(event: string): void
    ping: ReturnType<typeof vi.fn>
    terminate: ReturnType<typeof vi.fn>
  }
}

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

it('terminates a silently broken connection after a missed pong', () => {
  const ws = socket()
  ws.emit('open')
  vi.advanceTimersByTime(30_000)
  expect(ws.ping).toHaveBeenCalledTimes(1)
  expect(ws.terminate).not.toHaveBeenCalled()
  vi.advanceTimersByTime(30_000)
  expect(ws.terminate).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps an idle connection alive while the service answers pings', () => {
  const ws = socket()
  ws.emit('open')
  for (let i = 0; i < 5; i++) {
    vi.advanceTimersByTime(30_000)
    ws.emit('pong')
  }
  expect(ws.ping).toHaveBeenCalledTimes(5)
  expect(ws.terminate).not.toHaveBeenCalled()
})

it('cleans up the watchdog when the socket closes', () => {
  const ws = socket()
  ws.emit('open')
  ws.emit('close')
  vi.advanceTimersByTime(60_000)
  expect(ws.ping).not.toHaveBeenCalled()
  expect(ws.terminate).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('does not start a watchdog until the socket opens', () => {
  const ws = socket()
  vi.advanceTimersByTime(60_000)
  ws.emit('close')
  expect(ws.ping).not.toHaveBeenCalled()
  expect(ws.terminate).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
