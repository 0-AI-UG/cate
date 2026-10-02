import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { framePortOver } from '@kernel/rpc/contract'
import { RpcClient, createCapabilityProxy } from '@kernel/rpc/client'
import { createLifecycleBus } from '@kernel/lifecycle/contract'
import { createLogger, installLogSink, nullSink } from '@kernel/log/contract'
import { runtimeIdFor } from '@runtime/data/node'
import { dialLocal } from '@runtime/transports/node'
import { runtimeCapability } from './contract'
import { serveWorkspace, type Daemon } from './entry'

// Short paths: a Unix socket path must fit in ~104 bytes.
let tmp: string
let home: string
let root: string
const daemons: Daemon[] = []

beforeEach(() => {
  installLogSink(nullSink)
  tmp = fs.mkdtempSync('/tmp/cate-d-')
  home = path.join(tmp, 'h')
  root = path.join(tmp, 'w')
  fs.mkdirSync(home)
  fs.mkdirSync(root)
})

afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop({ kind: 'signal' })
  installLogSink(null)
  fs.rmSync(tmp, { recursive: true, force: true })
})

async function start(graceMs?: number) {
  const result = await serveWorkspace({
    root, home, lifecycle: createLifecycleBus(), log: createLogger('test'),
    ...(graceMs !== undefined ? { lifetime: { graceMs } } : {}),
  })
  if (result.kind === 'serving') daemons.push(result.daemon)
  return result
}

async function connect(endpoint: string) {
  const client = new RpcClient({
    version: 'test',
    identity: { client: { clientId: 'c1', device: { name: 'laptop', keyFingerprint: 'fp' }, features: ['canvas', 'nope'] } },
  })
  await client.attach(framePortOver(await dialLocal(endpoint), 'stream'))
  return { client, runtime: createCapabilityProxy(client, runtimeCapability) }
}

describe.skipIf(process.platform === 'win32')('daemon', () => {
  it('serves runtime.info over the local socket and writes runtime.json', async () => {
    const result = await start()
    if (result.kind !== 'serving') throw new Error('expected to serve')
    const { daemon } = result
    expect(daemon.endpoint).toBe(path.join(home, '.cate', 'workspaces', daemon.runtimeId, 'runtime.sock'))
    expect(fs.statSync(daemon.endpoint).mode & 0o777).toBe(0o600)

    const { client, runtime } = await connect(daemon.endpoint)
    const info = await runtime.info()
    expect(info).toMatchObject({
      runtimeId: daemon.runtimeId,
      root: fs.realpathSync(root),
      pid: process.pid,
      clients: [{ clientId: 'c1', device: { name: 'laptop', keyFingerprint: 'fp' }, features: ['canvas'] }],
    })
    const written = JSON.parse(fs.readFileSync(daemon.paths.runtimeInfo, 'utf-8'))
    expect(written).toMatchObject({ runtimeId: daemon.runtimeId, pid: process.pid, endpoints: { local: daemon.endpoint } })
    client.close()
  })

  it('a second serve for the same root finds the socket held', async () => {
    const first = await start()
    expect(first.kind).toBe('serving')
    const second = await start()
    expect(second).toMatchObject({ kind: 'running' })
  })

  it('runtime.stop stops the daemon and removes its socket', async () => {
    const result = await start()
    if (result.kind !== 'serving') throw new Error('expected to serve')
    const { client, runtime } = await connect(result.daemon.endpoint)
    await runtime.stop()
    await expect(result.daemon.stopped).resolves.toEqual({ kind: 'stop' })
    expect(fs.existsSync(result.daemon.endpoint)).toBe(false)
    client.close()
    // The workspace can be served again.
    expect((await start()).kind).toBe('serving')
  })

  it('stops on its own once the last client leaves and the grace period passes', async () => {
    const result = await start(100)
    if (result.kind !== 'serving') throw new Error('expected to serve')
    const { client, runtime } = await connect(result.daemon.endpoint)
    await new Promise((r) => setTimeout(r, 200))
    expect((await runtime.info()).clients).toHaveLength(1)
    client.close()
    await expect(result.daemon.stopped).resolves.toEqual({ kind: 'idle' })
  })

  it('refuses a workspace inside or around a live one, and tells the client why', async () => {
    expect((await start()).kind).toBe('serving')
    const inner = path.join(root, 'sub')
    fs.mkdirSync(inner)
    for (const at of [inner, tmp]) {
      const result = await serveWorkspace({ root: at, home, lifecycle: createLifecycleBus(), log: createLogger('test') })
      if (result.kind !== 'nested') throw new Error(`expected ${at} to be refused`)
      expect(result.message).toContain(fs.realpathSync(root))
      const endpoint = path.join(home, '.cate', 'workspaces', (await runtimeIdFor(at)), 'runtime.sock')
      await expect(connect(endpoint)).rejects.toThrow('Workspaces cannot be nested')
    }
  })

  it('refuses a nested workspace while the outer one is still starting', async () => {
    let started = false
    const outer = start().then((result) => { started = true; return result })
    const info = path.join(home, '.cate', 'workspaces', await runtimeIdFor(root), 'runtime.json')
    while (!fs.existsSync(info)) await new Promise((r) => setTimeout(r, 1))
    expect(started).toBe(false)
    const inner = path.join(root, 'sub')
    fs.mkdirSync(inner)
    const result = await serveWorkspace({ root: inner, home, lifecycle: createLifecycleBus(), log: createLogger('test') })
    expect(result.kind).toBe('nested')
    expect((await outer).kind).toBe('serving')
  })
})
