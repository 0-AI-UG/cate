import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RpcError,
  framePortOver,
  type ByteDuplex,
  type ProtocolVersion,
} from '@kernel/rpc/contract'
import { runtimeFor, setRuntimeResolver, tryRuntimeFor } from '@kernel/rpc/client'
import { RpcServer, type CapabilityImpl } from '@kernel/rpc/runtime'
import { workspaceCapability } from '@workspace/lifecycle/contract/capability'
import { tunnelCapability } from '@runtime/tunnel/contract/capability'
import { WorkspaceConnections } from './registry'
import { createClientIdentity, type ClientIdentity } from './identity'
import { sessionCapability } from '@panels/framework/contract/capability'
import type { ShellTransports } from './transports'
import { RUNTIME_CAPABILITIES } from '@panels/capabilities'
import { createLifecycleBus } from '@kernel/lifecycle/contract'

/** Two ends of an in-memory byte pipe; delivery is asynchronous. */
function bytePipe(): [ByteDuplex, ByteDuplex] {
  const data: ((b: Uint8Array) => void)[] = [() => {}, () => {}]
  const close: ((r?: string) => void)[][] = [[], []]
  // Writes already made still arrive, then the close.
  let closed = false
  let finished = false
  const end = (self: 0 | 1): ByteDuplex => ({
    write(bytes) {
      if (closed) return
      const copy = bytes.slice()
      queueMicrotask(() => { if (!finished) data[1 - self](copy) })
    },
    onData(listener) { data[self] = listener },
    onClose(listener) { close[self].push(listener) },
    close(reason) {
      if (closed) return
      closed = true
      queueMicrotask(() => {
        finished = true
        for (const l of [...close[0], ...close[1]]) l(reason)
      })
    },
  })
  return [end(0), end(1)]
}

interface FakeRuntime {
  server: RpcServer
  helloClientIds: string[]
  pipes: ByteDuplex[]
  down: boolean
  dials: number[]
  dropAll(): void
}

function fakeRuntime(opts: { protocol?: ProtocolVersion; build?: string; refuse?: boolean } = {}): FakeRuntime {
  const rt: FakeRuntime = {
    server: new RpcServer({
      lifecycle: createLifecycleBus(),
      version: '9.0.0',
      build: opts.build,
      protocol: opts.protocol,
      acceptHello: (hello) => {
        if (hello.client) rt.helloClientIds.push(hello.client.clientId)
        if (opts.refuse) throw new RpcError('rejected', 'unknown device')
      },
    }),
    helloClientIds: [],
    pipes: [],
    down: false,
    dials: [],
    dropAll() {
      for (const pipe of rt.pipes.splice(0)) pipe.close('dropped')
    },
  }
  rt.server.register(workspaceCapability, {
    info: () => ({ runtimeId: 'r1', root: '/w', name: 'w' }),
    getTrust: () => ({ trusted: true, decidedAt: null }),
    setTrust: ({ trusted }) => ({ trusted, decidedAt: null }),
    watchTrust: () => {},
  })
  return rt
}

function transportsFor(rt: FakeRuntime, extra: Partial<ShellTransports> = {}): ShellTransports {
  return {
    dialLocal: async () => {
      rt.dials.push(Date.now())
      if (rt.down) throw new Error('ECONNREFUSED')
      const [client, server] = bytePipe()
      rt.pipes.push(server)
      rt.server.serve(framePortOver(server, 'stream'))
      return client
    },
    dialLoopbackTcp: async () => { throw new Error('not expected') },
    ...extra,
  }
}

const identity: ClientIdentity = createClientIdentity({
  device: { name: 'test', keyFingerprint: 'FP' },
  features: ['canvas', 'webview'],
})

let registry: WorkspaceConnections | null = null
// The client core installs the runtime slot over its connections; so do
// these tests.
let stopResolver = () => {}
afterEach(() => {
  stopResolver()
  registry?.dispose()
  registry = null
  vi.useRealTimers()
})

function openLocal(rt: FakeRuntime, extra: Partial<ShellTransports> = {}, backoff = { initialMs: 10, maxMs: 1000, factor: 2 }, build?: string) {
  registry = new WorkspaceConnections({
      capabilities: RUNTIME_CAPABILITIES, identity, transports: transportsFor(rt, extra), version: '9.0.0', build, backoff })
  const opened = registry
  stopResolver = setRuntimeResolver((workspaceId) => opened.get(workspaceId)?.runtime ?? null)
  return registry.open('ws1', { kind: 'local', root: '/w' })
}

describe('WorkspaceConnection', () => {
  it('makes typed calls and fills the runtime slot', async () => {
    const rt = fakeRuntime()
    const connection = openLocal(rt)
    expect(runtimeFor('ws1')).toBe(connection.runtime)
    await expect(connection.runtime.workspace.info()).resolves.toEqual({ runtimeId: 'r1', root: '/w', name: 'w' })
    expect(connection.state).toEqual({ kind: 'connected' })
    expect(connection.clientHas('canvas')).toBe(true)
    expect(connection.clientHas('camera')).toBe(false)
    registry!.close('ws1')
    expect(tryRuntimeFor('ws1')).toBeNull()
    expect(connection.state.kind).toBe('closed')
  })

  it('reconnects with backoff, queues calls while offline and keeps its clientId', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const rt = fakeRuntime()
    const connection = openLocal(rt)
    await vi.advanceTimersByTimeAsync(0)
    expect(connection.state.kind).toBe('connected')
    const connectedAt = Date.now()

    rt.down = true
    rt.dropAll()
    await vi.advanceTimersByTimeAsync(0)
    expect(connection.state).toEqual({ kind: 'offline', lastSeen: connectedAt, retrying: true })

    const queued = connection.runtime.workspace.setTrust({ trusted: true })
    // 10 ms, then 20 ms, then 40 ms between dials.
    rt.dials.length = 0
    await vi.advanceTimersByTimeAsync(9)
    expect(rt.dials).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(rt.dials).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(19)
    expect(rt.dials).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(rt.dials).toHaveLength(2)
    expect(connection.state).toMatchObject({ kind: 'offline', retrying: true, error: 'ECONNREFUSED' })

    rt.down = false
    await vi.advanceTimersByTimeAsync(40)
    expect(rt.dials).toHaveLength(3)
    await expect(queued).resolves.toEqual({ trusted: true, decidedAt: null })
    expect(connection.state.kind).toBe('connected')

    // Backoff starts over after a successful connection.
    rt.dropAll()
    await vi.advanceTimersByTimeAsync(10)
    expect(connection.state.kind).toBe('connected')
    expect(new Set(rt.helloClientIds)).toEqual(new Set([identity.clientId]))
    expect(rt.helloClientIds.length).toBe(3)
  })

  it('reports an incompatible runtime and keeps the connection for crossMajor calls', async () => {
    const rt = fakeRuntime({ protocol: [99, 0] })
    const connection = openLocal(rt)
    await vi.waitFor(() => expect(connection.state).toEqual({ kind: 'incompatible', runtimeVersion: '9.0.0' }))
  })

  it('connects to a runtime of another build of the same protocol, as stale', async () => {
    const stale = openLocal(fakeRuntime({ build: '9.0.0+old' }), {}, undefined, '9.0.0+new')
    await vi.waitFor(() => expect(stale.state).toEqual({ kind: 'connected', stale: { runtime: '9.0.0+old', app: '9.0.0+new' } }))
    await expect(stale.runtime.workspace.info()).resolves.toEqual({ runtimeId: 'r1', root: '/w', name: 'w' })
    registry!.close('ws1')

    const unbuilt = openLocal(fakeRuntime(), {}, undefined, '9.0.0+new')
    await vi.waitFor(() => expect(unbuilt.state).toEqual({ kind: 'connected', stale: { runtime: null, app: '9.0.0+new' } }))
    registry!.close('ws1')

    const same = openLocal(fakeRuntime({ build: '9.0.0+new' }), {}, undefined, '9.0.0+new')
    await vi.waitFor(() => expect(same.state).toEqual({ kind: 'connected' }))
  })

  it('stops retrying when the runtime refuses the client', async () => {
    const rt = fakeRuntime({ refuse: true })
    const connection = openLocal(rt)
    await vi.waitFor(() => expect(connection.state).toEqual({ kind: 'refused', message: 'unknown device' }))
    await new Promise((r) => setTimeout(r, 40))
    expect(rt.dials).toHaveLength(1)
  })

  it('shares one session channel per panel and closes it with the last release', async () => {
    const rt = fakeRuntime()
    let opened = 0
    let closed = 0
    const sessionImpl: CapabilityImpl<typeof sessionCapability> = {
      op: () => null,
      subscribe: ({ panelId }, sink) => {
        opened++
        sink.emit({ kind: 'snapshot', rev: 0, snapshot: { panelId, n: 1 } })
        return () => { closed++ }
      },
    }
    rt.server.register(sessionCapability, sessionImpl)
    const connection = openLocal(rt)
    const a = connection.subscribeSession<{ panelId: string; n: number }>('p1')
    const b = connection.subscribeSession<{ panelId: string; n: number }>('p1')
    await vi.waitFor(() => expect(a.getSnapshot()?.snapshot).toEqual({ panelId: 'p1', n: 1 }))
    expect(b.getSnapshot()).toBe(a.getSnapshot())
    expect(opened).toBe(1)
    a.release()
    a.release()
    await new Promise((r) => setTimeout(r, 5))
    expect(closed).toBe(0)
    b.release()
    await vi.waitFor(() => expect(closed).toBe(1))
  })
})

describe('dialLoopback', () => {
  it('dials TCP on this machine for a local connection', async () => {
    const rt = fakeRuntime()
    const [mine] = bytePipe()
    const dialLoopbackTcp = vi.fn(async () => mine)
    const connection = openLocal(rt, { dialLoopbackTcp })
    await expect(connection.dialLoopback(3000)).resolves.toBe(mine)
    expect(dialLoopbackTcp).toHaveBeenCalledWith(3000)
  })

  it('opens tunnel.connect inside the connection for a network connection', async () => {
    const rt = fakeRuntime()
    const ports: number[] = []
    const tunnelImpl: CapabilityImpl<typeof tunnelCapability> = {
      connect: ({ port }, sink) => {
        ports.push(port)
        sink.onInput((bytes) => sink.bytes(new Uint8Array([...bytes].map((b) => b + 1))))
        sink.emit({ kind: 'open' })
      },
    }
    rt.server.register(tunnelCapability, tunnelImpl)
    const dialLoopbackTcp = vi.fn(async (): Promise<ByteDuplex> => { throw new Error('must not dial TCP') })
    registry = new WorkspaceConnections({
      capabilities: RUNTIME_CAPABILITIES,
      identity,
      version: '9.0.0',
      transports: {
        dialLocal: async () => { throw new Error('must not dial the local socket') },
        dialNetwork: async () => {
          const [client, server] = bytePipe()
          rt.server.serve(framePortOver(server, 'message'))
          return client
        },
        dialLoopbackTcp,
      },
    })
    const connection = registry.open('ws2', { kind: 'network', runtimeId: 'r2', endpoints: [{ kind: 'connect' }] })
    const pipe = await connection.dialLoopback(5173)
    const received: number[] = []
    pipe.onData((bytes) => received.push(...bytes))
    pipe.write(new Uint8Array([1, 2, 3]))
    await vi.waitFor(() => expect(received).toEqual([2, 3, 4]))
    expect(ports).toEqual([5173])
    expect(dialLoopbackTcp).not.toHaveBeenCalled()
    const closedWith = new Promise<string | undefined>((resolve) => pipe.onClose(resolve))
    pipe.close('done')
    await expect(closedWith).resolves.toBe('done')
  })
})
