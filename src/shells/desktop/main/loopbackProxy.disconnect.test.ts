import http from 'node:http'
import { Duplex } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { startLoopbackProxy, type LoopbackProxyOptions } from './loopbackProxy'

const credentials = { username: 'cate', password: 'test' }
const authorization = `Basic ${Buffer.from('cate:test').toString('base64')}`
const disconnected = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
const socket = () => new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback() } })

async function fixture(event: 'connect' | 'upgrade', overrides: Partial<LoopbackProxyOptions> = {}) {
  const createServer = vi.spyOn(http, 'createServer')
  const proxy = await startLoopbackProxy({
    credentials,
    reachesClientNetwork: () => false,
    lookup: async () => ['93.184.216.34'],
    dialLoopback: async () => { throw new Error('unreachable') },
    ...overrides,
  })
  const server = createServer.mock.results[0].value as http.Server
  createServer.mockRestore()
  const handle = server.listeners(event)[0] as (req: http.IncomingMessage, client: Duplex, head: Buffer) => Promise<void>
  return { proxy, handle }
}

function request(event: 'connect' | 'upgrade', url?: string, authorized = true): http.IncomingMessage {
  return {
    method: 'GET',
    url: url ?? (event === 'connect' ? 'example.test:443' : 'http://example.test/ws'),
    headers: authorized ? { 'proxy-authorization': authorization } : {},
    rawHeaders: [],
  } as unknown as http.IncomingMessage
}

describe.each(['connect', 'upgrade'] as const)('%s disconnects', (event) => {
  it.each(['unauthorized', 'malformed', 'refused', 'unreachable'] as const)('handles a failed write of the %s response', async (failure) => {
    const { proxy, handle } = await fixture(event, {
      lookup: async () => failure === 'refused' ? ['192.168.1.2'] : Promise.reject(new Error('unreachable')),
    })
    const client = socket()
    try {
      await handle(request(event, failure === 'malformed' ? 'invalid' : undefined, failure !== 'unauthorized'), client, Buffer.alloc(0))
      // Raw HTTP upgrade sockets no longer have the server's error handler.
      expect(() => client.emit('error', disconnected())).not.toThrow()
      expect(client.destroyed).toBe(true)
    } finally {
      client.destroy()
      await proxy.close()
    }
  })

  it('handles a client reset while dialing and closes the late target', async () => {
    let connected!: (target: Duplex) => void
    const dial = vi.fn(() => new Promise<Duplex>((resolve) => { connected = resolve }))
    const { proxy, handle } = await fixture(event, { dialDirect: dial })
    const client = socket()
    const target = socket()
    const pending = handle(request(event), client, Buffer.alloc(0))
    try {
      await expect.poll(() => dial.mock.calls.length).toBe(1)
      expect(() => client.emit('error', disconnected())).not.toThrow()
      connected(target)
      await pending
      expect(client.destroyed).toBe(true)
      expect(target.destroyed).toBe(true)
    } finally {
      client.destroy()
      connected(target)
      await pending
      target.destroy()
      await proxy.close()
    }
  })

  it('closes a pending client on proxy shutdown and releases its late target', async () => {
    let connected!: (target: Duplex) => void
    const dial = vi.fn(() => new Promise<Duplex>((resolve) => { connected = resolve }))
    const { proxy, handle } = await fixture(event, { dialDirect: dial })
    const client = socket()
    const target = socket()
    const pending = handle(request(event), client, Buffer.alloc(0))
    try {
      await expect.poll(() => dial.mock.calls.length).toBe(1)
      await proxy.close()
      expect(client.destroyed).toBe(true)
      connected(target)
      await pending
      expect(target.destroyed).toBe(true)
    } finally {
      client.destroy()
      connected(target)
      await pending
      target.destroy()
      await proxy.close()
    }
  })
})
