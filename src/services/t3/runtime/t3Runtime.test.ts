import { promises as fs } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { WebSocketServer } from 'ws'
import { isRpcError, RpcError } from '@kernel/rpc/contract'
import { t3Capability, type T3ShellEvent } from '../contract'
import type { ServerHost } from '@runtime/server/runtime'
import { createT3Runtime, t3InstanceId, t3Paths, type T3PtyHost, type T3Runtime, type T3RuntimeDeps } from './index'

// A stand-in for the T3 server: the HTTP routes and the WebSocket RPC the
// runtime uses, on one loopback port.
interface FakeT3 {
  port: number
  dispatched: Array<Record<string, unknown>>
  cookies: string[]
  threads: Array<Record<string, unknown>>
  close(): Promise<void>
}

async function fakeT3(): Promise<FakeT3> {
  const state: FakeT3 = { port: 0, dispatched: [], cookies: [], threads: [], close: async () => {} }
  const server = http.createServer((req, res) => {
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(JSON.stringify(body))
    }
    if (req.url === '/.well-known/t3/environment') return json(200, { environmentId: 'env' })
    if (req.url === '/api/auth/browser-session') return json(200, {}, { 'set-cookie': 't3session=abc; Path=/; HttpOnly' })
    state.cookies.push(String(req.headers.cookie))
    if (req.url === '/api/orchestration/shell') return json(200, { threads: [{ id: 't1', title: 'One', updatedAt: 'now', extra: 1 }] })
    if (req.url?.startsWith('/api/orchestration/threads/missing')) return json(404, {})
    if (req.url?.startsWith('/api/orchestration/threads/')) {
      return json(200, { thread: { runtimeMode: 'full-access', messages: [
        { role: 'user', text: 'hi', createdAt: 'a' }, { role: 'system', text: 'x', createdAt: 'b' },
      ] } })
    }
    if (req.url === '/api/orchestration/dispatch') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => { state.dispatched.push(JSON.parse(body)); json(200, {}) })
      return
    }
    json(404, {})
  })
  // The ws typings in src/types cover only the options the app uses.
  type Socket = { send(data: string): void; on(event: 'message', cb: (data: Buffer) => void): void; terminate(): void }
  const Server = WebSocketServer as unknown as new (options: { server: http.Server }) => WebSocketServer & { clients: Set<Socket> }
  const wss = new Server({ server })
  wss.on('connection', (socket: Socket) => socket.on('message', (data) => {
    const request = JSON.parse(data.toString())
    if (request.tag === 'orchestration.subscribeShell') {
      socket.send(JSON.stringify({ _tag: 'Chunk', requestId: request.id, values: [
        { kind: 'snapshot', snapshot: { snapshotSequence: 1, threads: state.threads } },
      ] }))
    } else if (request.tag === 'server.getConfig') {
      socket.send(JSON.stringify({ _tag: 'Exit', requestId: request.id, exit: { _tag: 'Success', value: { settings: { a: 1 }, providers: [] } } }))
    } else if (request._tag === 'Request') {
      socket.send(JSON.stringify({ _tag: 'Exit', requestId: request.id, exit: { _tag: 'Success', value: null } }))
    }
  }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  state.port = (server.address() as AddressInfo).port
  state.close = async () => {
    for (const client of wss.clients) client.terminate()
    wss.close()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
  return state
}

let dataDir: string
let root: string
let worktree: string
let t3: FakeT3
let trusted: boolean
let runtime: T3Runtime
let exits: Map<string, (id: string, code: number | null, signal: string | null) => void>
let server: { start: Mock<ServerHost['start']>; stop: Mock<ServerHost['stop']> }
let pty: { spawn: Mock<T3PtyHost['spawn']>; write: Mock<(data: string) => void>; kill: Mock<() => void> }

function deps(overrides: Partial<T3RuntimeDeps> = {}): T3RuntimeDeps {
  return {
    root,
    t3Root: path.join(dataDir, 't3'),
    trust: {
      isTrusted: () => trusted,
      requireTrusted: () => { if (!trusted) throw new RpcError('untrusted') },
    },
    resolveCheckout: async (checkout) => {
      const resolved = checkout ?? root
      if (resolved !== root && resolved !== worktree) throw new RpcError('rejected', 'not a checkout')
      return resolved
    },
    server,
    pty,
    harness: { node: '/bin/node', entry: '/tarball/t3/dist/bin.mjs' },
    cateSocket: '/data/runtime.sock',
    mintHarnessToken: (checkout) => `token:${checkout}`,
    homeDir: '/home/me',
    ...overrides,
  }
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-t3-'))
  root = '/work/repo'
  worktree = '/work/repo/.cate/worktrees/feature'
  trusted = true
  t3 = await fakeT3()
  exits = new Map()
  let next = 0
  server = {
    start: vi.fn<ServerHost['start']>(async (_opts, _onOutput, onExit) => {
      const id = `srv-${++next}`
      exits.set(id, onExit)
      return { id, pid: 100 + next, port: t3.port }
    }),
    stop: vi.fn<ServerHost['stop']>((id) => exits.get(id)?.(id, null, 'SIGTERM')),
  }
  const write = vi.fn<(data: string) => void>()
  const kill = vi.fn<() => void>()
  pty = { write, kill, spawn: vi.fn<T3PtyHost['spawn']>(() => ({ write, kill })) }
  runtime = createT3Runtime(deps())
})

afterEach(async () => {
  await runtime.dispose()
  await t3.close()
  await fs.rm(dataDir, { recursive: true, force: true })
})

describe('T3 harness', () => {
  it('runs one instance per checkout under the workspace data dir, with the cate socket and token', async () => {
    const [first, second] = await Promise.all([runtime.panelUrl({}), runtime.panelUrl({ threadId: 'saved' })])
    expect(server.start).toHaveBeenCalledOnce()
    const [options] = server.start.mock.calls[0]
    const baseDir = path.join(dataDir, 't3', 'instances', t3InstanceId(root))
    expect(options).toMatchObject({
      command: ['/bin/node', '/tarball/t3/dist/bin.mjs', '--bootstrap-fd', '0', '--auto-bootstrap-project-from-cwd'],
      cwd: root,
      env: { T3CODE_HOME: baseDir, CATE_SOCKET: '/data/runtime.sock', CATE_TOKEN: `token:${root}` },
      portEnv: 'T3CODE_PORT',
      includeCateCli: true,
    })
    expect(JSON.parse(options.bootstrapStdin!)).toMatchObject({ t3Home: baseDir, host: '127.0.0.1' })
    expect(first).toEqual({
      url: `http://127.0.0.1:${t3.port}/`,
      port: t3.port,
      instanceId: t3InstanceId(root),
      environmentId: 'env',
      threadId: null,
      session: { name: 't3session', value: 'abc' },
    })
    expect(second.url).toBe(`http://127.0.0.1:${t3.port}/env/saved`)
    expect((await runtime.panelUrl({ route: 'usage' })).url).toBe(`http://127.0.0.1:${t3.port}/usage`)

    const settings = JSON.parse(await fs.readFile(t3Paths(path.join(dataDir, 't3'), root).settings, 'utf-8'))
    expect(settings).toMatchObject({ defaultThreadEnvMode: 'local', enableAgentBrowserAccess: false, providers: { grok: { enabled: false } } })

    await runtime.panelUrl({ checkout: worktree })
    expect(server.start).toHaveBeenCalledTimes(2)
    expect(server.start.mock.calls[1][0].env?.T3CODE_HOME).toBe(path.join(dataDir, 't3', 'instances', t3InstanceId(worktree)))
    expect(await runtime.status({})).toEqual({ phase: 'running' })
  })

  it('has no T3 Connect', async () => {
    const names = [...Object.keys(t3Capability.methods), ...Object.keys(t3Capability.streams)]
    expect(names.filter((name) => /remote|connect/i.test(name))).toEqual([])
    await runtime.panelUrl({})
    const { command, env = {}, bootstrapStdin } = server.start.mock.calls[0][0]
    expect(command).not.toContain('connect')
    expect(Object.keys(env).filter((key) => /TAILSCALE|CONNECT|RELAY/.test(key))).toEqual([])
    expect(JSON.parse(bootstrapStdin!).tailscaleServeEnabled).toBe(false)
  })

  it('refuses to start anything in an untrusted workspace', async () => {
    trusted = false
    for (const call of [
      () => runtime.panelUrl({}),
      () => runtime.providerAuthStart({ providerId: 'codex' }),
      () => runtime.conversations({}),
      () => runtime.startTurn({ threadId: 't1', text: 'go' }),
      () => runtime.providerStatuses({}),
    ]) {
      await expect(call()).rejects.toSatisfy((error: unknown) => isRpcError(error, 'untrusted'))
    }
    expect(server.start).not.toHaveBeenCalled()
    expect(pty.spawn).not.toHaveBeenCalled()
    expect(await runtime.status({})).toEqual({ phase: 'stopped' })
  })

  it('refuses a path that is not a checkout of the workspace', async () => {
    await expect(runtime.panelUrl({ checkout: '/elsewhere' })).rejects.toThrow('not a checkout')
    expect(server.start).not.toHaveBeenCalled()
  })

  it('restarts a checkout and reports an exit', async () => {
    await runtime.panelUrl({})
    await runtime.panelUrl({ checkout: worktree })
    await runtime.restart({})
    expect(server.stop).toHaveBeenCalledExactlyOnceWith('srv-1')
    expect(await runtime.status({})).toEqual({ phase: 'stopped' })
    expect((await runtime.status({ checkout: worktree })).phase).toBe('running')
    await runtime.panelUrl({})
    expect(server.start).toHaveBeenCalledTimes(3)

    exits.get('srv-3')!('srv-3', 1, null)
    expect(await runtime.status({})).toMatchObject({ phase: 'error', message: expect.stringContaining('code 1') })
    await runtime.panelUrl({})
    expect(server.start).toHaveBeenCalledTimes(4)
  })

  it('reports a failed start and allows a retry', async () => {
    server.start.mockRejectedValueOnce(new Error('server launch failed'))
    await expect(runtime.panelUrl({})).rejects.toThrow('server launch failed')
    expect(await runtime.status({})).toEqual({ phase: 'error', message: 'server launch failed' })
    await runtime.panelUrl({})
    expect((await runtime.status({})).phase).toBe('running')
  })

  it('stops a start that finishes during shutdown', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const start = server.start.getMockImplementation()!
    server.start.mockImplementationOnce(async (...args: Parameters<ServerHost['start']>) => { await gate; return start(...args) })
    const opening = runtime.panelUrl({})
    await vi.waitFor(() => expect(server.start).toHaveBeenCalledOnce())
    const shutdown = runtime.dispose()
    release()
    await Promise.all([expect(opening).rejects.toThrow('cancelled'), shutdown])
    expect(server.stop).toHaveBeenCalledExactlyOnceWith('srv-1')
  })
})

describe('T3 conversations and thread shells', () => {
  it('lists, reads, renames, deletes and starts turns with the harness session', async () => {
    expect(await runtime.conversations({})).toEqual([{ id: 't1', title: 'One', updatedAt: 'now' }])
    expect(await runtime.readConversation({ threadId: 't1' })).toEqual([{ role: 'user', text: 'hi', createdAt: 'a' }])
    expect(await runtime.readConversation({ threadId: 'missing' })).toBeNull()
    const events: T3ShellEvent[] = []
    const stop = runtime.watchThreadShells((event) => events.push(event))
    await runtime.renameConversation({ threadId: 't1', title: ' New ' })
    await runtime.deleteConversation({ threadId: 't1' })
    await runtime.startTurn({ threadId: 't1', text: 'go on' })
    stop()
    expect(t3.dispatched).toMatchObject([
      { type: 'thread.meta.update', threadId: 't1', title: 'New' },
      { type: 'thread.delete', threadId: 't1' },
      { type: 'thread.turn.start', threadId: 't1', runtimeMode: 'full-access', interactionMode: 'default', message: { role: 'user', text: 'go on' } },
    ])
    expect(events).toContainEqual({ kind: 'deleted', instanceId: t3InstanceId(root), threadId: 't1' })
    expect(new Set(t3.cookies)).toEqual(new Set(['t3session=abc']))
  })

  it('streams thread shells and is busy while a turn runs', async () => {
    t3.threads = [{ id: 't1', title: 'One', latestTurn: { state: 'running' } }]
    const events: T3ShellEvent[] = []
    runtime.watchThreadShells((event) => events.push(event))
    await runtime.panelUrl({})
    await vi.waitFor(() => expect(events.some((event) => event.kind === 'snapshot' && event.snapshot.connected)).toBe(true))
    expect(events[0]).toMatchObject({ kind: 'snapshot', snapshot: { instanceId: t3InstanceId(root), checkout: root, threads: { t1: { title: 'One' } } } })
    expect(runtime.busy()).toBe(true)
    expect(await runtime.threadActivity({ threadId: 't1' })).toEqual({ activity: 'running', canReceivePrompt: false })

    const late: T3ShellEvent[] = []
    runtime.watchThreadShells((event) => late.push(event))
    expect(late).toHaveLength(1)

    await runtime.restart({})
    await vi.waitFor(() => expect(runtime.busy()).toBe(false))
  })
})

describe('T3 providers', () => {
  it('signs in with the profile binary and home, and routes input and cancellation', async () => {
    const paths = t3Paths(path.join(dataDir, 't3'), root)
    await fs.mkdir(paths.root, { recursive: true })
    await fs.writeFile(paths.providerProfile, JSON.stringify({ providers: { codex: { binaryPath: '/opt/codex', shadowHomePath: '~/auth' } } }))
    const session = await runtime.providerAuthStart({ providerId: 'codex' })
    const [options, onData, onExit] = pty.spawn.mock.calls[0]
    expect(options).toMatchObject({
      file: '/opt/codex', args: ['login', '--device-auth'], cwd: root,
      env: { CODEX_HOME: '/home/me/auth', TERM: 'xterm-256color' },
    })
    expect(server.start).not.toHaveBeenCalled()
    expect(runtime.busy()).toBe(true)
    onData('Open https://auth.example.test/device.\r\nCode ABCD-1234\r\n')
    expect(runtime.providerAuthGet(session.id)).toMatchObject({ url: 'https://auth.example.test/device', code: 'ABCD-1234', phase: 'running' })
    runtime.providerAuthWrite(session.id, '\r')
    expect(pty.write).toHaveBeenCalledWith('\r')
    runtime.providerAuthCancel(session.id)
    expect(pty.kill).toHaveBeenCalledOnce()
    onExit(0)
    expect(runtime.providerAuthGet(session.id).phase).toBe('cancelled')
    expect(runtime.busy()).toBe(false)
    expect(() => runtime.providerAuthGet('nope')).toThrow('not found')
  })

  it('reads provider status from the instance caches', async () => {
    await runtime.panelUrl({})
    const paths = t3Paths(path.join(dataDir, 't3'), root)
    await fs.mkdir(paths.caches, { recursive: true })
    await fs.writeFile(path.join(paths.caches, 'codex.json'), JSON.stringify({ enabled: true, installed: true, auth: { status: 'authenticated', label: 'Pro' } }))
    const statuses = await runtime.providerStatuses({})
    expect(statuses.find((status) => status.providerId === 'codex')).toEqual({ providerId: 'codex', state: 'authenticated', label: 'Pro' })
    expect(statuses.find((status) => status.providerId === 'claude')).toEqual({ providerId: 'claude', state: 'unknown' })
  })

  it('publishes saved provider settings and secrets (0600) to the workspace profile and other checkouts', async () => {
    await runtime.panelUrl({})
    await runtime.panelUrl({ checkout: worktree })
    const t3Root = path.join(dataDir, 't3')
    const main = t3Paths(t3Root, root)
    const other = t3Paths(t3Root, worktree)
    const settings = JSON.parse(await fs.readFile(main.settings, 'utf-8'))
    await fs.writeFile(main.settings, JSON.stringify({ ...settings, providers: { codex: { enabled: true, binaryPath: '/opt/codex' } } }))
    await fs.mkdir(main.secrets, { recursive: true })
    await fs.writeFile(path.join(main.secrets, 'provider-env-a.bin'), 'secret', { mode: 0o644 })
    await fs.writeFile(path.join(main.secrets, 'desktop-bootstrap-token.bin'), 'not copied')

    await expect(runtime.providerSettings({ operation: 'save', patch: { theme: 'x' } })).rejects.toThrow('Unsupported')
    expect(await runtime.providerSettings({ operation: 'save', patch: { providers: {} } })).toEqual({ settings: { a: 1 }, providers: [] })

    expect(JSON.parse(await fs.readFile(main.providerProfile, 'utf-8'))).toEqual({ providers: { codex: { enabled: true, binaryPath: '/opt/codex' } } })
    expect(await fs.readdir(main.providerSecrets)).toEqual(['provider-env-a.bin'])
    expect((await fs.stat(path.join(main.providerSecrets, 'provider-env-a.bin'))).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await fs.readFile(other.settings, 'utf-8')).providers.codex).toEqual({ enabled: true, binaryPath: '/opt/codex' })
    expect(await fs.readFile(path.join(other.secrets, 'provider-env-a.bin'), 'utf-8')).toBe('secret')
  })
})
