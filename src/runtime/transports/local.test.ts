import { afterEach, beforeEach, expect, it } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { defineCapability, framePortOver, method } from '@kernel/rpc/contract'
import { RpcClient, createCapabilityProxy } from '@kernel/rpc/client'
import { RpcServer } from '@kernel/rpc/runtime'
import { createLifecycleBus } from '@kernel/lifecycle/contract'
import { dialLocal } from './node'
import { serveLocal } from './runtime'

const pingCap = defineCapability('ping', { methods: { ping: method<void, string>() } })

let dir: string
beforeEach(() => { dir = fs.mkdtempSync('/tmp/cate-t-') })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

it.skipIf(process.platform === 'win32')('holds connections that arrive before open, then serves them', async () => {
  const endpoint = path.join(dir, 's.sock')
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(endpoint, resolve))
  const rpc = new RpcServer({ version: 'test', lifecycle: createLifecycleBus() })
  const listener = serveLocal(server, rpc)

  const client = new RpcClient({ version: 'test', identity: { caller: { token: 't' } } })
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
