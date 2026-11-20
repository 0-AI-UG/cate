import { afterEach, beforeEach, expect, it } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { defineCapability, framePortOver, method } from '@kernel/rpc/contract'
import { RpcClient, createCapabilityProxy } from '@kernel/rpc/client'
import { RpcServer } from '@kernel/rpc/runtime'
import { createLifecycleBus } from '@kernel/lifecycle/contract'
import { dialLocal } from './node'
import { serveLocal } from './runtime'

const pingCap = defineCapability('ping', { methods: { ping: method<void, string>() } })

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-t-')) })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

it.skipIf(process.platform === 'win32')('holds connections that arrive before open, then serves them', async () => {
  const endpoint = path.join(dir, 's.sock')
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(endpoint, resolve))
  const rpc = new RpcServer({ version: 'test', lifecycle: createLifecycleBus() })
  const listener = serveLocal(server, rpc)

  const client = new RpcClient({ version: 'test', identity: { client: { clientId: 'c1', device: { name: 'test', publicKey: 'fp' }, features: [] } } })
  const ready = client.attach(framePortOver(await dialLocal(endpoint), 'stream'))
  await new Promise((r) => setTimeout(r, 50))
  rpc.register(pingCap, { ping: () => 'pong' })
  listener.open()
  await ready
  expect(await createCapabilityProxy(client, pingCap).ping()).toBe('pong')

  client.close()
  await listener.close()
  await expect(dialLocal(endpoint, { timeoutMs: 500 })).rejects.toThrow()
})

it('handles a client reset while the runtime is still starting', async () => {
  const server = net.createServer()
  const rpc = new RpcServer({ version: 'test', lifecycle: createLifecycleBus() })
  const listener = serveLocal(server, rpc)
  const socket = new net.Socket()
  try {
    server.emit('connection', socket)
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    expect(() => socket.emit('error', reset)).not.toThrow()
    expect(socket.destroyed).toBe(true)
    // The disconnected client must not be served when startup finishes.
    listener.open()
  } finally {
    socket.destroy()
    await listener.close()
    rpc.close()
  }
})
