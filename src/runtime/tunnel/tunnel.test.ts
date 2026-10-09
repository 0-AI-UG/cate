import { afterEach, beforeEach, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createMemoryPortPair, isRpcError } from '@kernel/rpc/contract'
import { RpcClient, createCapabilityProxy } from '@kernel/rpc/client'
import { RpcServer } from '@kernel/rpc/runtime'
import { createLifecycleBus } from '@kernel/lifecycle/contract'
import { tunnelCapability, type LoopbackHost } from './contract'
import { tunnelCapabilityImpl } from './runtime'

let httpServer: http.Server
let port: number
let client: RpcClient

beforeEach(async () => {
  httpServer = http.createServer((req, res) => {
    if (req.url === '/big') res.end('x'.repeat(3 * 1024 * 1024))
    else res.end(`hello ${req.url}`)
  })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  port = (httpServer.address() as AddressInfo).port

  const rpc = new RpcServer({ version: 'test', lifecycle: createLifecycleBus() })
  rpc.register(tunnelCapability, tunnelCapabilityImpl())
  const [serverPort, clientPort] = createMemoryPortPair()
  rpc.serve(serverPort)
  client = new RpcClient({ version: 'test', identity: { caller: { token: 't' } } })
  await client.attach(clientPort)
})

afterEach(async () => {
  client.close()
  await new Promise<void>((resolve) => httpServer.close(() => resolve()))
})

function fetchThrough(path: string, host?: LoopbackHost): Promise<string> {
  const tunnel = createCapabilityProxy(client, tunnelCapability)
  const sub = tunnel.connect({ port, ...(host ? { host } : {}) })
  const chunks: Buffer[] = []
  sub.onBytes((bytes) => chunks.push(Buffer.from(bytes)))
  sub.onEvent((event) => {
    if (event.kind === 'open') sub.write(new TextEncoder().encode(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`))
  })
  return sub.done.then(() => Buffer.concat(chunks).toString('utf-8'))
}

it('carries an HTTP exchange to a loopback server', async () => {
  const response = await fetchThrough('/hi')
  expect(response).toMatch(/^HTTP\/1\.1 200 OK/)
  expect(response.endsWith('hello /hi')).toBe(true)
})

it('carries a body larger than the credit window', async () => {
  const response = await fetchThrough('/big')
  expect(response.length).toBeGreaterThan(3 * 1024 * 1024)
})

it('refuses anything but loopback', async () => {
  const tunnel = createCapabilityProxy(client, tunnelCapability)
  for (const host of ['10.0.0.1', 'localhost', 'example.com', '0.0.0.0']) {
    const err = await tunnel.connect({ port, host: host as LoopbackHost }).done.catch((e) => e)
    expect(isRpcError(err, 'rejected')).toBe(true)
  }
  const badPort = await tunnel.connect({ port: 70000 }).done.catch((e) => e)
  expect(isRpcError(badPort, 'rejected')).toBe(true)
})

it('fails when nothing listens on the port', async () => {
  const closed = await new Promise<number>((resolve) => {
    const s = http.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port
      s.close(() => resolve(p))
    })
  })
  const tunnel = createCapabilityProxy(client, tunnelCapability)
  const err = await tunnel.connect({ port: closed }).done.catch((e) => e)
  expect(isRpcError(err, 'gone')).toBe(true)
})
