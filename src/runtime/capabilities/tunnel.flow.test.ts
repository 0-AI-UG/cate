// =============================================================================
// Flow-control e2e for the tunnel capability (electron-free, no mocks). Stands up
// a localhost server that floods a large response, opens a tunnel to it, consumes
// the data slowly while sending acks, and asserts every byte arrives intact
// (round-trip integrity). The credit window (WINDOW_HIGH/LOW in tunnel.ts) pauses
// the source socket once enough is outstanding; acking eventually resumes it and
// delivers all bytes. We assert integrity + full delivery rather than exact pause
// timing (a strict pause assertion would be flaky).
// =============================================================================

import { describe, it, expect } from 'vitest'
import net from 'net'
import { createTunnelCapability } from './tunnel'

describe('tunnel capability — daemon→client flow control', () => {
  it('delivers a large flooded response intact when the client acks', async () => {
    // Server that immediately floods ~4 MiB (well past the 1 MiB window) on connect.
    const TOTAL = 4 * 1024 * 1024
    const payload = Buffer.alloc(TOTAL, 0)
    for (let i = 0; i < TOTAL; i++) payload[i] = i & 0xff // deterministic pattern
    const server = net.createServer((socket) => { socket.end(payload) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    const port = addr && typeof addr === 'object' ? addr.port : 0

    const tunnel = createTunnelCapability()
    const received: Buffer[] = []
    let closed = false
    const closeGate = new Promise<void>((resolve) => {
      void tunnel.open(
        'c1',
        port,
        (connId, b64) => {
          const buf = Buffer.from(b64, 'base64')
          received.push(buf)
          // Consume slowly: ack after a short delay so the window has a chance to
          // fill and pause the source, then drains as acks arrive.
          setTimeout(() => tunnel.ack(connId, buf.length), 1)
        },
        () => { closed = true; resolve() },
      )
    })

    await closeGate
    expect(closed).toBe(true)
    const got = Buffer.concat(received)
    expect(got.length).toBe(TOTAL)
    expect(got.equals(payload)).toBe(true) // every byte intact, in order

    tunnel.closeAll()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('ack on an unknown/closed conn is a no-op (no throw)', () => {
    const tunnel = createTunnelCapability()
    expect(() => tunnel.ack('nope', 1024)).not.toThrow()
  })
})
