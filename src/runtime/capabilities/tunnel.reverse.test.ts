// =============================================================================
// Reverse-tunnel e2e for the tunnel capability (electron-free, no mocks).
// Stands up a 127.0.0.1 listener via createTunnelCapability().listen(), connects
// to its port (simulating the extension server), and asserts the bidirectional
// byte bridge: inbound bytes surface via onConnection/onData keyed by a connId,
// and bytes written back via tunnel.write(connId) arrive at the connecting
// socket. Then asserts stopListen() closes the listener.
// =============================================================================

import { describe, it, expect } from 'vitest'
import net from 'net'
import { createTunnelCapability } from './tunnel'

function once<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('tunnel capability — reverse listener (e2e)', () => {
  it('bridges an inbound connection both ways, then stopListen closes it', async () => {
    const tunnel = createTunnelCapability()

    const connGate = once<string>()
    const dataGate = once<{ connId: string; chunk: string }>()
    const closeGate = once<string>()

    const { port } = await tunnel.listen(
      'l1',
      (connId) => connGate.resolve(connId),
      (connId, chunk) => dataGate.resolve({ connId, chunk }),
      (connId) => closeGate.resolve(connId),
    )
    expect(port).toBeGreaterThan(0)

    // Simulate the extension server connecting to the daemon's CATE_API listener.
    const client = net.connect(port, '127.0.0.1')
    await new Promise<void>((resolve) => client.on('connect', resolve))

    // onConnection fires with a fresh connId.
    const connId = await connGate.promise
    expect(typeof connId).toBe('string')

    // Inbound bytes (client → listener) surface via onData as base64.
    client.write(Buffer.from('hello-up'))
    const { connId: dataConnId, chunk } = await dataGate.promise
    expect(dataConnId).toBe(connId)
    expect(Buffer.from(chunk, 'base64').toString('utf8')).toBe('hello-up')

    // Outbound bytes (tunnel.write → client) arrive on the connecting socket.
    const backGate = once<string>()
    client.on('data', (b: Buffer) => backGate.resolve(b.toString('utf8')))
    tunnel.write(connId, Buffer.from('hello-down').toString('base64'))
    expect(await backGate.promise).toBe('hello-down')

    // stopListen closes the listener and destroys accepted sockets → the client
    // socket ends, and a fresh connection to the port is refused.
    tunnel.stopListen('l1')
    await new Promise<void>((resolve) => client.on('close', resolve))

    const refused = await new Promise<boolean>((resolve) => {
      const s = net.connect(port, '127.0.0.1')
      s.on('connect', () => { s.destroy(); resolve(false) })
      s.on('error', () => resolve(true))
    })
    expect(refused).toBe(true)
  })
})
