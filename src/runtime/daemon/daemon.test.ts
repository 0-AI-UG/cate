import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { framePortOver } from '@kernel/rpc/contract'
import { RpcClient, createCapabilityProxy } from '@kernel/rpc/client'
import { createLifecycleBus } from '@kernel/lifecycle/contract'
import { createLogger, installLogSink } from '@kernel/log/contract'
import { RUNTIME_STOP_DEADLINE_MS } from '@runtime/data/contract'
import { runtimeIdFor } from '@runtime/data/node'
import { socketAnswers } from '@runtime/data/runtime'
import { dialLocal } from '@runtime/transports/node'
import { runtimeCapability } from './contract'
import { serveWorkspace, type Daemon } from './entry'
import { pairOverLocal } from './compose/pairOverLocal'

// Short paths: a Unix socket path must fit in ~104 bytes.
let tmp: string
let home: string
let root: string
const daemons: Daemon[] = []

beforeEach(() => {
  installLogSink(() => {})
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
      await expect(connect(endpoint)).rejects.toThrow('which is already open in Cate')
    }
  })

  it('names the open workspace it is inside, in the message and as data', async () => {
    expect((await start()).kind).toBe('serving')
    const inner = path.join(root, 'sub')
    fs.mkdirSync(inner)
    const result = await serveWorkspace({ root: inner, home, lifecycle: createLifecycleBus(), log: createLogger('test') })
    if (result.kind !== 'nested') throw new Error('expected a refusal')
    expect(result.message).toBe(`${fs.realpathSync(inner)} is inside the workspace ${fs.realpathSync(root)}, which is already open in Cate. Open that workspace instead, or close it first.`)
    const endpoint = path.join(home, '.cate', 'workspaces', await runtimeIdFor(inner), 'runtime.sock')
    const refused = await connect(endpoint).then(() => null, (err: { data?: unknown }) => err)
    expect(refused?.data).toEqual({ nested: { root: fs.realpathSync(root) } })
  })

  it('a stale runtime.json of a runtime that no longer answers does not block', async () => {
    // A killed runtime leaves runtime.json behind; its pid may be reused by
    // any live process (here: this one).
    const outerId = await runtimeIdFor(root)
    const dir = path.join(home, '.cate', 'workspaces', outerId)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({
      runtimeId: outerId, root: fs.realpathSync(root), pid: process.pid, version: '0', protocol: [1, 0],
      endpoints: { local: path.join(dir, 'runtime.sock') },
    }))
    const inner = path.join(root, 'sub')
    fs.mkdirSync(inner)
    const result = await serveWorkspace({ root: inner, home, lifecycle: createLifecycleBus(), log: createLogger('test') })
    if (result.kind === 'serving') daemons.push(result.daemon)
    expect(result.kind).toBe('serving')
  })

  it('a sibling folder sharing a name prefix is a different workspace', async () => {
    expect((await start()).kind).toBe('serving')
    const sibling = `${root}-2`
    fs.mkdirSync(sibling)
    const result = await serveWorkspace({ root: sibling, home, lifecycle: createLifecycleBus(), log: createLogger('test') })
    if (result.kind === 'serving') daemons.push(result.daemon)
    expect(result.kind).toBe('serving')
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

  it('waits for the daemon that last owned the workspace to exit before serving it', async () => {
    // A stopping daemon closes its socket first and lets go of the
    // workspace's files last: its successor must not overlap it.
    const runtimeId = await runtimeIdFor(root)
    const dir = path.join(home, '.cate', 'workspaces', runtimeId)
    fs.mkdirSync(dir, { recursive: true })
    const program = path.join(tmp, 'runtime.cjs')
    fs.writeFileSync(program, "process.on('SIGTERM', () => {}); console.log('up'); setTimeout(() => {}, 400)")
    const previous = spawn(process.execPath, [program])
    await new Promise<void>((resolve) => previous.stdout.once('data', () => resolve()))
    let exitedAt = 0
    previous.once('exit', () => { exitedAt = Date.now() })
    fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({
      runtimeId, root: fs.realpathSync(root), pid: previous.pid, version: '0', protocol: [1, 0], endpoints: { local: path.join(dir, 'runtime.sock') },
    }))

    const result = await start()
    expect(result.kind).toBe('serving')
    expect(exitedAt).toBeGreaterThan(0)
  })

  it('cate serve on a workspace already running trusts it', async () => {
    const result = await serveWorkspace({ root, home, lifecycle: createLifecycleBus(), log: createLogger('test') })
    if (result.kind !== 'serving') throw new Error('expected to serve')
    expect(result.daemon.workspace.trust.isTrusted()).toBe(false)
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await pairOverLocal(result.daemon.endpoint, 'sameNetwork', root, true)
    } finally {
      write.mockRestore()
    }
    expect(result.daemon.workspace.trust.isTrusted()).toBe(true)
    await result.daemon.stop({ kind: 'signal' })
  })

  it('binds the socket before a slow process preparation finishes', async () => {
    let release!: () => void
    const started = Date.now()
    const serving = serveWorkspace({
      root,
      home,
      lifecycle: createLifecycleBus(),
      log: createLogger('test'),
      prepareProcess: () => new Promise<void>((resolve) => { release = resolve; setTimeout(resolve, 8_000) }),
    })
    const endpoint = path.join(home, '.cate', 'workspaces', await runtimeIdFor(root), 'runtime.sock')
    await vi.waitFor(async () => expect(await socketAnswers(endpoint, 200)).toBe(true), { timeout: 1_000, interval: 50 })
    expect(Date.now() - started).toBeLessThan(1_000)
    release()
    const result = await serving
    if (result.kind === 'serving') await result.daemon.stop({ kind: 'signal' })
  }, 15_000)

  it('a stuck shutdown step does not lose the last document change', async () => {
    const lifecycle = createLifecycleBus()
    lifecycle.onShutdown(() => new Promise<void>(() => {}))
    const result = await serveWorkspace({ root, home, lifecycle, log: createLogger('test') })
    if (result.kind !== 'serving') throw new Error('expected to serve')
    result.daemon.workspace.document.apply({ kind: 'setWorktree', worktree: { id: 'wt-last', path: path.join(root, 'x'), color: 'blue', status: 'ready' } })
    void result.daemon.stop({ kind: 'signal' })
    await result.daemon.stopped
    const saved = JSON.parse(fs.readFileSync(path.join(result.daemon.paths.dir, 'document.json'), 'utf8')) as { document: { worktrees: Record<string, unknown> } }
    expect(Object.keys(saved.document.worktrees)).toContain('wt-last')
  }, RUNTIME_STOP_DEADLINE_MS + 10_000)

  it('a stuck shutdown still resolves stopped once the stop deadline passes', async () => {
    const lifecycle = createLifecycleBus()
    lifecycle.onShutdown(() => new Promise<void>(() => {}))
    const result = await serveWorkspace({ root, home, lifecycle, log: createLogger('test') })
    if (result.kind !== 'serving') throw new Error('expected to serve')
    const started = Date.now()
    void result.daemon.stop({ kind: 'signal' })
    await expect(result.daemon.stopped).resolves.toEqual({ kind: 'signal' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(RUNTIME_STOP_DEADLINE_MS - 50)
  }, RUNTIME_STOP_DEADLINE_MS + 10_000)
})
