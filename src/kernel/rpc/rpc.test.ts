import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  CancelledError,
  ConnectionClosedError,
  IncompatibleProtocolError,
  RpcError,
  channelStream,
  createMemoryPortPair,
  defineCapability,
  isRpcError,
  method,
  stream,
  type ChannelEvent,
  type FramePort,
  type Subscription,
} from './contract'
import { RpcServer, type CapabilityImpl, type CallContext } from './runtime'
import { RpcClient, createCapabilityProxy, mirrorChannel } from './client'
import { createLifecycleBus, type ClientConnection } from '@kernel/lifecycle/contract'

const testCap = defineCapability('test', {
  methods: {
    read: method<{ path: string }, string>(),
    bump: method<{ by: number }, number>({ mutates: true }),
    wait: method<void, string>(),
    info: method<void, { version: string }>({ crossMajor: true }),
    whoami: method<void, { clientId: string | null; canvas: boolean; token: string | null }>(),
  },
  streams: {
    ticks: stream<{ every: number }, { n: number }>(),
    pump: stream<{ total: number; chunk: number }, never, { pauses: number }>({ bytes: true }),
    echo: stream<void, never>({ bytes: true }),
    doc: channelStream<void, { title: string; count: number }>(),
  },
})

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

function deferred<T = void>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

function makeImpl(overrides: Partial<CapabilityImpl<typeof testCap>> = {}): CapabilityImpl<typeof testCap> {
  let counter = 0
  return {
    read: ({ path }) => `contents of ${path}`,
    bump: ({ by }) => (counter += by),
    wait: (_p, ctx) => new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('aborted')))),
    info: () => ({ version: '9.9.9' }),
    whoami: (_p, ctx) => ({
      clientId: ctx.connection.client?.clientId ?? null,
      canvas: ctx.connection.has('canvas'),
      token: ctx.connection.caller?.token ?? null,
    }),
    ticks: ({ every }, sink) => {
      let n = 0
      const timer = setInterval(() => sink.emit({ n: ++n }), every)
      return () => clearInterval(timer)
    },
    pump: async ({ total, chunk }, sink) => {
      let pauses = 0
      for (let sent = 0; sent < total; sent += chunk) {
        if (!sink.bytes(new Uint8Array(chunk).fill(sent / chunk))) {
          pauses++
          await sink.drain()
        }
      }
      sink.end({ pauses })
    },
    echo: (_p, sink) => { sink.onInput((bytes) => sink.bytes(bytes)) },
    doc: (_p, sink) => {
      sink.emit({ kind: 'snapshot', rev: 0, snapshot: { title: 'a', count: 0 } })
      sink.emit({ kind: 'change', rev: 1, change: { count: 1 } })
    },
    ...overrides,
  }
}

function setup(opts: { server?: Partial<ConstructorParameters<typeof RpcServer>[0]>; impl?: Partial<CapabilityImpl<typeof testCap>>; caller?: boolean } = {}) {
  const lifecycle = createLifecycleBus()
  const server = new RpcServer({ version: '1.0.0', lifecycle, ...opts.server })
  server.register(testCap, makeImpl(opts.impl))
  const client = new RpcClient({
    version: '1.0.0',
    identity: opts.caller
      ? { caller: { token: 'tok' } }
      : { client: { clientId: 'c1', device: { name: 'mac', publicKey: 'fp' }, features: ['canvas', 'hologram'] } },
  })
  const api = createCapabilityProxy(client, testCap)
  const connect = (): { port: FramePort; ready: Promise<unknown> } => {
    const [serverPort, clientPort] = createMemoryPortPair()
    server.serve(serverPort)
    return { port: clientPort, ready: client.attach(clientPort) }
  }
  return { server, client, api, connect, lifecycle }
}

describe('rpc server and client', () => {
  it('makes typed calls with named params', async () => {
    const { api, connect } = setup()
    await connect().ready
    expectTypeOf(api.read).parameter(0).toEqualTypeOf<{ path: string }>()
    expectTypeOf(api.read).returns.toEqualTypeOf<Promise<string>>()
    expectTypeOf(api.ticks).returns.toEqualTypeOf<Subscription<{ n: number }, void>>()
    await expect(api.read({ path: '/a' })).resolves.toBe('contents of /a')
    await expect(api.whoami()).resolves.toEqual({ clientId: 'c1', canvas: true, token: null })
  })

  it('queues calls made before the connection is ready', async () => {
    const { api, connect, client } = setup()
    const pending = api.read({ path: '/early' })
    const sub = api.ticks({ every: 1 })
    expect(client.state).toBe('disconnected')
    connect()
    await expect(pending).resolves.toBe('contents of /early')
    const first = await sub[Symbol.asyncIterator]().next()
    expect(first.value).toEqual({ n: 1 })
    sub.cancel()
  })

  it('starts handlers in arrival order, methods like streams', async () => {
    const added = new Set<string>()
    const { api, connect } = setup({
      impl: {
        read: ({ path }) => { added.add(path); return path },
        ticks: (_p, sink) => { sink.emit({ n: added.size }) },
      },
    })
    await connect().ready
    // A subscribe sent right after the call that creates what it follows.
    void api.read({ path: '/new' })
    const sub = api.ticks({ every: 1 })
    expect((await sub[Symbol.asyncIterator]().next()).value).toEqual({ n: 1 })
    sub.cancel()
  })

  it('fails unknown methods and capabilities with unsupported', async () => {
    const { client, connect } = setup()
    await connect().ready
    const err = await client.call('test', 'nope', {}).catch((e) => e)
    expect(isRpcError(err, 'unsupported')).toBe(true)
    await expect(client.call('ghost', 'read', {})).rejects.toMatchObject({ code: 'unsupported' })
    const sub = client.subscribe('test', 'missing', undefined)
    await expect(sub.done).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('carries error codes and plain errors', async () => {
    const { api, connect } = setup({
      impl: {
        read: ({ path }) => {
          if (path === 'gone') throw new RpcError('gone', 'no such panel', { id: 'p1' })
          throw new Error('disk on fire')
        },
      },
    })
    await connect().ready
    const coded = await api.read({ path: 'gone' }).catch((e) => e)
    expect(coded).toBeInstanceOf(RpcError)
    expect(coded).toMatchObject({ code: 'gone', message: 'no such panel', data: { id: 'p1' } })
    const plain = await api.read({ path: 'x' }).catch((e) => e)
    expect(plain).not.toBeInstanceOf(RpcError)
    expect(plain.message).toBe('disk on fire')
  })

  it('refuses a different protocol major but still allows crossMajor methods', async () => {
    const { api, client, connect } = setup({ server: { protocol: [2, 0] } })
    const queued = api.read({ path: '/a' })
    await connect().ready
    expect(client.state).toBe('incompatible')
    await expect(queued).rejects.toBeInstanceOf(IncompatibleProtocolError)
    await expect(api.read({ path: '/b' })).rejects.toBeInstanceOf(IncompatibleProtocolError)
    await expect(api.info()).resolves.toEqual({ version: '9.9.9' })
  })

  it('accepts a different minor', async () => {
    const { api, connect } = setup({ server: { protocol: [1, 7] } })
    await connect().ready
    await expect(api.read({ path: '/a' })).resolves.toBe('contents of /a')
  })

  it('cancels a call through its signal and aborts the handler', async () => {
    const aborted = deferred()
    const { api, connect } = setup({
      impl: {
        wait: (_p, ctx: CallContext) => new Promise(() => ctx.signal.addEventListener('abort', () => aborted.resolve())),
      },
    })
    await connect().ready
    const controller = new AbortController()
    const call = api.wait(undefined, { signal: controller.signal })
    await tick()
    controller.abort()
    await expect(call).rejects.toBeInstanceOf(CancelledError)
    await aborted.promise
  })

  it('times out and cancels on the runtime', async () => {
    const aborted = deferred()
    const { api, connect } = setup({
      impl: { wait: (_p, ctx) => new Promise(() => ctx.signal.addEventListener('abort', () => aborted.resolve())) },
    })
    await connect().ready
    await expect(api.wait(undefined, { timeoutMs: 10 })).rejects.toMatchObject({ code: 'timeout' })
    await aborted.promise
  })

  it('cancels a stream and runs its cleanup', async () => {
    const cleanup = vi.fn()
    const { api, connect } = setup({
      impl: {
        ticks: (_p, sink) => {
          const timer = setInterval(() => sink.emit({ n: 1 }), 1)
          return () => { clearInterval(timer); cleanup() }
        },
      },
    })
    await connect().ready
    const sub = api.ticks({ every: 1 })
    const seen: number[] = []
    for await (const event of sub) {
      seen.push(event.n)
      if (seen.length === 3) break // return() cancels
    }
    await expect(sub.done).rejects.toBeInstanceOf(CancelledError)
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1))
  })

  it('flow-controls byte streams with ack', async () => {
    const { api, connect } = setup({ server: { window: { high: 1000, low: 500 } } })
    await connect().ready
    const sub = api.pump({ total: 4000, chunk: 400 }, { manualAck: true })
    let received = 0
    sub.onBytes((bytes) => { received += bytes.length })
    await tick(); await tick()
    // 400, 800 fit; the third chunk crosses the window and the producer waits.
    expect(received).toBe(1200)
    await tick()
    expect(received).toBe(1200)
    sub.onBytes((bytes) => sub.ack(bytes.length))
    sub.ack(1200)
    const result = await sub.done
    expect(received).toBe(4000)
    expect(result.pauses).toBeGreaterThanOrEqual(1)
  })

  it('acks automatically and carries client bytes to the handler', async () => {
    const { api, connect } = setup()
    await connect().ready
    const sub = api.echo()
    sub.write(new Uint8Array([1, 2, 3]))
    const got = await new Promise<Uint8Array>((resolve) => sub.onBytes(resolve))
    expect([...got]).toEqual([1, 2, 3])
    sub.cancel()
  })

  it('applies a resent mutating call once (opId dedupe across reconnect)', async () => {
    const release = deferred()
    let runs = 0
    let total = 0
    const { api, connect, client } = setup({
      impl: {
        bump: async ({ by }, ctx) => {
          runs++
          expect(ctx.opId).toMatch(/^c1:\d+$/)
          await release.promise
          return (total += by)
        },
      },
    })
    const first = connect()
    await first.ready
    const call = api.bump({ by: 5 })
    await tick()
    expect(runs).toBe(1)
    first.port.close('network blip')
    await tick()
    expect(client.state).toBe('disconnected')
    const second = connect()
    await second.ready
    await tick()
    release.resolve()
    await expect(call).resolves.toBe(5)
    expect(runs).toBe(1)
    await expect(api.bump({ by: 1 })).resolves.toBe(6)
    expect(runs).toBe(2)
  })

  it('answers an op whose outcome is no longer kept with duplicate', async () => {
    const { api, connect, client, server } = setup({ server: { opResultCache: 1 } })
    await connect().ready
    await api.bump({ by: 1 })
    await api.bump({ by: 1 })
    // A second client with the same clientId whose counter restarted.
    const again = new RpcClient({ version: '1.0.0', identity: { client: { clientId: 'c1', device: { name: 'mac', publicKey: 'fp' }, features: [] } } })
    const [serverPort, clientPort] = createMemoryPortPair()
    server.serve(serverPort)
    await again.attach(clientPort)
    await expect(createCapabilityProxy(again, testCap).bump({ by: 1 })).rejects.toMatchObject({ code: 'duplicate' })
    again.close()
    client.close()
  })

  it('resumes streams marked resume and fails the others on disconnect', async () => {
    const { api, connect } = setup()
    const first = connect()
    await first.ready
    const snapshots: string[] = []
    const doc = api.doc(undefined, { resume: true })
    doc.onEvent((e) => { if (e.kind === 'snapshot') snapshots.push(e.snapshot.title) })
    const ticks = api.ticks({ every: 5 })
    await tick(); await tick()
    first.port.close()
    await expect(ticks.done).rejects.toBeInstanceOf(ConnectionClosedError)
    await connect().ready
    await vi.waitFor(() => expect(snapshots).toEqual(['a', 'a']))
    doc.cancel()
  })

  it('mirrors a channel', async () => {
    const { api, connect } = setup()
    await connect().ready
    const mirror = mirrorChannel<{ title: string; count: number }>(() => api.doc() as Subscription<ChannelEvent<{ title: string; count: number }, Partial<{ title: string; count: number }>>, unknown>)
    await vi.waitFor(() => expect(mirror.get()).toEqual({ rev: 1, snapshot: { title: 'a', count: 1 } }))
    mirror.dispose()
  })

  it('reports client presence on the lifecycle bus', async () => {
    const { connect, lifecycle } = setup()
    const up: ClientConnection[] = []
    const down: ClientConnection[] = []
    lifecycle.onClientConnected((c) => up.push(c))
    lifecycle.onClientGone((c) => down.push(c))
    const { port, ready } = connect()
    await ready
    await tick()
    expect(up).toHaveLength(1)
    expect(up[0]).toMatchObject({ clientId: 'c1', device: { name: 'mac' }, features: ['canvas'] })
    port.close()
    await tick()
    expect(down).toEqual(up)
  })

  it('lets a caller in with a token and refuses what acceptHello rejects', async () => {
    const ok = setup({ caller: true, server: { acceptHello: (h) => { if (h.caller?.token !== 'tok') throw new RpcError('rejected') } } })
    await ok.connect().ready
    await expect(ok.api.whoami()).resolves.toEqual({ clientId: null, canvas: false, token: 'tok' })

    const refused = setup({ server: { acceptHello: () => { throw new RpcError('untrusted', 'unknown device') } } })
    const pending = refused.api.read({ path: '/a' })
    pending.catch(() => {})
    await expect(refused.connect().ready).rejects.toMatchObject({ code: 'untrusted' })
    expect(refused.client.state).toBe('refused')
    await expect(pending).rejects.toMatchObject({ code: 'untrusted' })
  })

  it('rejects calls from a caller with an opId it cannot own', async () => {
    const { server, connect } = setup({ caller: true })
    await connect().ready
    const [serverPort, clientPort] = createMemoryPortPair()
    server.serve(serverPort)
    const replies: unknown[] = []
    clientPort.onFrame((f) => { if (f.kind === 'msg') replies.push(f.msg) })
    clientPort.send({ kind: 'msg', msg: { t: 'req', id: 1, cap: 'test', method: 'read', params: { path: '/' } } })
    clientPort.send({ kind: 'msg', msg: { t: 'hello', protocol: [1, 0], version: 'x', caller: { token: 't' } } })
    clientPort.send({ kind: 'msg', msg: { t: 'req', id: 2, cap: 'test', method: 'bump', params: { by: 1 }, opId: 'c9:1' } })
    await vi.waitFor(() => expect(replies).toHaveLength(3))
    expect(replies[0]).toMatchObject({ t: 'res', id: 1, error: { code: 'rejected' } })
    expect(replies[2]).toMatchObject({ t: 'res', id: 2, error: { code: 'rejected' } })
  })

  it('validates declarations and registrations', () => {
    expect(() => defineCapability('bad name', {})).toThrow()
    expect(() => defineCapability('x', { methods: { a: method() }, streams: { a: stream() } })).toThrow()
    const server = new RpcServer({ version: '1', lifecycle: createLifecycleBus() })
    expect(() => server.register(testCap, {} as CapabilityImpl<typeof testCap>)).toThrow(/no handler/)
  })
})

describe('mirrorChannel', () => {
  it('tells listeners when a channel ends for good', async () => {
    let opened = 0
    let end!: () => void
    const mirror = mirrorChannel<{ title: string }>(() => {
      opened++
      const listeners = new Set<(e: ChannelEvent<{ title: string }, Partial<{ title: string }>>) => void>()
      const first = opened === 1
      const done = first ? new Promise<void>((resolve) => { end = resolve }) : Promise.reject(new RpcError('gone'))
      done.catch(() => {})
      if (first) queueMicrotask(() => { for (const l of listeners) l({ kind: 'snapshot', rev: 1, snapshot: { title: 'a' } }) })
      return { onEvent: (l: never) => { listeners.add(l); return () => listeners.delete(l) }, done, cancel: () => {} } as never
    })
    const seen: unknown[] = []
    mirror.subscribe((state) => seen.push(state))
    await vi.waitFor(() => expect(seen).toEqual([{ rev: 1, snapshot: { title: 'a' } }]))
    end()
    await vi.waitFor(() => expect(seen.at(-1)).toBeNull())
    expect(mirror.get()).toBeNull()
    mirror.dispose()
  })
})
