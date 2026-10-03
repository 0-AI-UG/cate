// Two clients in one workspace, in process: a real daemon (every module, every
// panel type) in a temp HOME, client A on its local socket and client B paired
// over the same-network transport on loopback, through the desktop shell's own
// transport host. Each client is a real WorkspaceConnection with the real
// document mirror and presence, under its own workspaceId (as B's `paired:`
// id differs from A's in the app), so `createPanel` and the registries work
// per client.
//
// The fast layer under e2e/shared: whole-runtime behaviour with two clients,
// without Electron.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createLifecycleBus } from '@kernel/lifecycle/contract'
import { createLogger, installLogSink, nullSink } from '@kernel/log/contract'
import { createMemoryDeviceStore } from '@kernel/state/contract'
import type { ByteDuplex, ChannelState } from '@kernel/rpc/contract'
import { createClientIdentity, WorkspaceConnection, type ConnectionState, type SessionHandle, type ShellTransports } from '@client/connections'
import { attachDocument, documentStoreFor, type DocumentStore } from '@client/document'
import { createPanel, registerPanelDefinitions } from '@client/host'
import { PANEL_DEFINITIONS } from '@panels/definitions'
import { KnownRuntimes } from '@runtime/pairing/client'
import { fingerprint, generateKeyPair } from '@runtime/security/contract'
import { dialSameNetwork } from '@runtime/transports/client'
import { dialLocal } from '@runtime/transports/node'
import * as Y from 'yjs'
import { attachBuffer, type AttachedBuffer } from '@workspace/files/client'
import { BUFFER_TEXT } from '@workspace/files/contract'
import { createShellTransportHost } from '../shells/desktop/main/transports'
import { serveWorkspace, type Daemon } from '../runtime/daemon/entry'

export interface TestClient {
  name: string
  workspaceId: string
  connection: WorkspaceConnection
  document: DocumentStore
  /** Creates a panel through this client's `createPanel`. */
  createPanel(type: string, options?: Record<string, unknown>): string
  /** Subscribes to a panel's session once the panel is in this client's
   *  document, as a view does. */
  session<S = Record<string, unknown>>(panelId: string): SessionProbe<S>
  /** Attaches to a file's shared buffer as an editor view does. */
  buffer(path: string): TestBuffer
  /** Cuts this client's link and fails its dials until `online`. */
  offline(): void
  online(): void
  /** Delays every chunk on this client's link, both ways, by `latencyMs`
   *  plus up to `jitterMs` (order kept per direction). Null: a fast link.
   *  Applies to the live link and every later one. */
  slow(delay: LinkDelay | null): void
  /** Closes the connection and drops its document mirror. */
  close(): void
}

export interface TestBuffer {
  doc: Y.Doc
  text: Y.Text
  attached: AttachedBuffer
}

export interface SessionProbe<S> {
  snapshot(): S | null
  send(op: unknown): Promise<unknown>
  until(ready: (s: S) => boolean, timeoutMs?: number): Promise<S>
  release(): void
}

export interface SharedWorkspace {
  root: string
  home: string
  /** The serving daemon (a new one after `restartRuntime`). */
  readonly daemon: Daemon
  a: TestClient
  b: TestClient
  /** Another client: `local` on A's machine, or a newly paired device. */
  join(name: string, transport: 'local' | 'network'): Promise<TestClient>
  /** Stops the daemon and serves the workspace again from its saved state. */
  restartRuntime(): Promise<void>
  /** Stops every client and the daemon, and removes the temp dirs. */
  stop(): Promise<void>
}

export interface SharedWorkspaceOptions {
  git?: boolean
  files?: Record<string, string>
}

let registered = false
let counter = 0

/** Polls `read` until it returns something other than undefined. */
export async function until<T>(read: () => Promise<T | undefined> | T | undefined, timeoutMs = 10_000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

export const untilState = (c: TestClient, kind: ConnectionState['kind'], timeoutMs = 10_000) =>
  until(() => (c.connection.state.kind === kind ? c.connection.state : undefined), timeoutMs, `${c.name} ${kind}`)

export async function startSharedWorkspace(opts: SharedWorkspaceOptions = {}): Promise<SharedWorkspace> {
  if (!registered) {
    registerPanelDefinitions(PANEL_DEFINITIONS)
    registered = true
  }
  installLogSink(nullSink)
  // Short paths: a Unix socket path must fit in ~104 bytes.
  const tmp = fs.realpathSync(fs.mkdtempSync('/tmp/cate-s-'))
  const home = path.join(tmp, 'h')
  const root = path.join(tmp, 'w')
  fs.mkdirSync(home)
  fs.mkdirSync(root)
  for (const [file, text] of Object.entries(opts.files ?? { 'README.md': '# shared\n' })) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), text)
  }
  if (opts.git ?? true) {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    git('init', '-q', '-b', 'trunk')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init')
  }
  const saved = { HOME: process.env.HOME, SHELL: process.env.SHELL }
  process.env.HOME = home
  process.env.SHELL = '/bin/sh'

  // The LAN port is the runtimeId's preferred one, as in the app, so it
  // survives a restart.
  const serve = async (): Promise<Daemon> => {
    const served = await serveWorkspace({
      root,
      home,
      network: 'sameNetwork',
      lifecycle: createLifecycleBus(),
      log: createLogger('test'),
      lan: { host: '127.0.0.1', advertise: false, addresses: (port) => [`127.0.0.1:${port}`] },
    })
    if (served.kind !== 'serving') throw new Error(`expected to serve, got ${served.kind}`)
    return served.daemon
  }
  let daemon = await serve()
  const clients: TestClient[] = []
  const buffers: { attached: AttachedBuffer; doc: Y.Doc }[] = []

  const makeClient = (name: string, workspaceId: string, connection: WorkspaceConnection, link: Link): TestClient => {
    const detach = attachDocument(connection)
    connection.start()
    const client: TestClient = {
      name,
      workspaceId,
      connection,
      document: documentStoreFor(workspaceId)!,
      createPanel(type, options = {}) {
        const id = createPanel(workspaceId, type, options)
        if (!id) throw new Error(`${name} could not create ${type}`)
        return id
      },
      session<S>(panelId: string): SessionProbe<S> {
        let handle: SessionHandle<S> | null = null
        const known = () => !!client.document.getSnapshot().panels[panelId] && client.document.isSynced()
        const acquire = () => {
          if (!handle && known()) handle = connection.subscribeSession<S>(panelId)
          return handle ?? undefined
        }
        const snapshot = () => (acquire()?.getSnapshot() as ChannelState<S> | null)?.snapshot ?? null
        return {
          snapshot,
          send: async (op) => (await until(acquire, 5_000, `${name} sees panel ${panelId}`)).send(op),
          until: (ready, timeoutMs) => until(() => {
            const s = snapshot()
            return s && ready(s) ? s : undefined
          }, timeoutMs, `${name} session ${panelId}`),
          release: () => handle?.release(),
        }
      },
      buffer(path) {
        const doc = new Y.Doc()
        const attached = attachBuffer(connection.runtime.file, path, doc)
        buffers.push({ attached, doc })
        return { doc, text: doc.getText(BUFFER_TEXT), attached }
      },
      offline: link.offline,
      online: link.online,
      slow: link.slow,
      close() {
        detach()
        connection.close()
      },
    }
    clients.push(client)
    return client
  }

  const localClient = (name: string): TestClient => {
    const link = createLink()
    const transports: ShellTransports = {
      dialLocal: link.wrap(() => dialLocal(daemon.endpoint)),
      dialLoopbackTcp: () => Promise.reject(new Error('no loopback in tests')),
    }
    const workspaceId = `local-${name}-${counter++}`
    return makeClient(name, workspaceId, new WorkspaceConnection({
      workspaceId,
      target: { kind: 'local', root },
      transports,
      identity: createClientIdentity({ device: { name, keyFingerprint: '' }, features: ['canvas', 'windows'] }),
      version: 'test',
      backoff: { initialMs: 20, maxMs: 200 },
    }), link)
  }

  const networkClient = async (name: string, inviter: TestClient): Promise<TestClient> => {
    const keys = generateKeyPair()
    const host = createShellTransportHost({
      startLocal: () => Promise.reject(new Error('a paired device has no local runtime')),
      deviceKeys: () => keys,
      deviceName: () => name,
      pins: new KnownRuntimes(createMemoryDeviceStore()),
      // mDNS, as on a real network: the runtime's current addresses.
      sameNetwork: (options) => dialSameNetwork({ ...options, discover: async () => daemon.network.addresses() }),
      cateConnect: () => Promise.reject(new Error('no Cate Connect in tests')),
    })
    const secret = await inviter.connection.runtime.pairing.createSecret({ mode: 'sameNetwork' })
    const paired = await host.pair({ link: secret.uri })
    const [address, port] = paired.addresses[0]!.split(':')
    const workspaceId = `paired:${paired.runtimeId}-${counter++}`
    const link = createLink()
    return makeClient(name, workspaceId, new WorkspaceConnection({
      workspaceId,
      target: { kind: 'network', runtimeId: paired.runtimeId, endpoints: [{ kind: 'lan', address: address!, port: Number(port) }] },
      transports: {
        dialLocal: () => Promise.reject(new Error('no local runtime')),
        dialNetwork: link.wrap((target) => host.dialNetwork(target)),
        dialLoopbackTcp: () => Promise.reject(new Error('no loopback in tests')),
      },
      identity: createClientIdentity({ device: { name, keyFingerprint: fingerprint(keys.publicKey) }, features: ['canvas'] }),
      version: 'test',
      backoff: { initialMs: 20, maxMs: 200 },
    }), link)
  }

  const a = localClient('A')
  await a.document.ready
  await a.connection.runtime.workspace.setTrust({ trusted: true })
  const b = await networkClient('B', a)
  await b.document.ready

  return {
    root,
    home,
    get daemon() { return daemon },
    a,
    b,
    async join(name, transport) {
      const c = transport === 'local' ? localClient(name) : await networkClient(name, a)
      await c.document.ready
      return c
    },
    async restartRuntime() {
      await daemon.stop({ kind: 'signal' })
      daemon = await serve()
    },
    async stop() {
      for (const b of buffers) { b.attached.close(); b.doc.destroy() }
      for (const c of clients) c.close()
      await daemon.stop({ kind: 'signal' })
      process.env.HOME = saved.HOME
      process.env.SHELL = saved.SHELL
      // The log sink stays null: a runtime write still settling after stop
      // must not log into a test file that already finished.
      // Async rm retries ENOTEMPTY (a late write); rmSync ignores maxRetries on Node 22.
      await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 10 })
    },
  }
}

export interface LinkDelay {
  latencyMs: number
  jitterMs?: number
}

interface Link {
  wrap<A extends unknown[]>(dial: (...args: A) => Promise<ByteDuplex>): (...args: A) => Promise<ByteDuplex>
  offline(): void
  online(): void
  slow(delay: LinkDelay | null): void
}

/** A client's link to the runtime, which a test can cut or slow down. */
function createLink(): Link {
  let down = false
  let delay: LinkDelay | null = null
  let current: ByteDuplex | null = null
  return {
    wrap: (dial) => async (...args) => {
      if (down) throw new Error('offline')
      const duplex = delayed(await dial(...args), () => delay)
      if (down) {
        duplex.close('offline')
        throw new Error('offline')
      }
      current = duplex
      return duplex
    },
    offline() {
      down = true
      current?.close('offline')
      current = null
    },
    online() { down = false },
    slow(next) { delay = next },
  }
}

/** One direction of a slow link: each step runs after the delay, in the
 *  order it was queued (one queue, one timer, so equal due times keep it). */
function lane(delay: () => LinkDelay | null): (step: () => void) => void {
  const queue: { due: number; step: () => void }[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  const pump = () => {
    timer = null
    while (queue.length && queue[0]!.due <= Date.now()) queue.shift()!.step()
    if (queue.length) timer = setTimeout(pump, queue[0]!.due - Date.now())
  }
  return (step) => {
    const d = delay()
    if (!d && queue.length === 0) { step(); return }
    const last = queue.length ? queue[queue.length - 1]!.due : 0
    queue.push({ due: Math.max(last, Date.now() + (d ? d.latencyMs + Math.random() * (d.jitterMs ?? 0) : 0)), step })
    if (!timer) timer = setTimeout(pump, queue[0]!.due - Date.now())
  }
}

function delayed(inner: ByteDuplex, delay: () => LinkDelay | null): ByteDuplex {
  const out = lane(delay)
  const into = lane(delay)
  return {
    // A write that lands after the link closed goes nowhere, as on a wire.
    write: (bytes) => { const copy = bytes.slice(); out(() => { try { inner.write(copy) } catch { /* closed */ } }) },
    onData: (listener) => inner.onData((bytes) => { const copy = bytes.slice(); into(() => listener(copy)) }),
    onClose: (listener) => inner.onClose((reason) => into(() => listener(reason))),
    close: (reason) => inner.close(reason),
  }
}
