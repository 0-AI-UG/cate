// End to end: a daemon composed with every module, in a temp HOME, driven by
// real RpcClients over the local socket.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { apiCapability } from '@kernel/api/contract'
import { RpcClient, createCapabilityProxy } from '@kernel/rpc/client'
import { framePortOver, type ChannelEvent } from '@kernel/rpc/contract'
import { createLifecycleBus } from '@kernel/lifecycle/contract'
import { createLogger, installLogSink, nullSink } from '@kernel/log/contract'
import { dialLocal } from '@runtime/transports/node'
import { workspaceCapability } from '@workspace/lifecycle/contract'
import { MAIN_WINDOW, documentCapability, type DocOp } from '@workspace/document/contract'
import { sessionCapability } from '@panels/framework/contract'
import { agentsCapability } from '@services/agents/contract'
import { serveWorkspace, type Daemon } from './entry'

let tmp: string
let home: string
let root: string
let daemon: Daemon | undefined
const clients: RpcClient[] = []
const saved = { HOME: process.env.HOME, SHELL: process.env.SHELL }

beforeEach(() => {
  installLogSink(nullSink)
  // Short paths: a Unix socket path must fit in ~104 bytes.
  tmp = fs.realpathSync(fs.mkdtempSync('/tmp/cate-w-'))
  home = path.join(tmp, 'h')
  root = path.join(tmp, 'w')
  fs.mkdirSync(home)
  fs.mkdirSync(root)
  process.env.HOME = home
  process.env.SHELL = '/bin/sh'
})

afterEach(async () => {
  for (const client of clients.splice(0)) client.close()
  await daemon?.stop({ kind: 'signal' })
  daemon = undefined
  process.env.HOME = saved.HOME
  process.env.SHELL = saved.SHELL
  installLogSink(null)
  fs.rmSync(tmp, { recursive: true, force: true })
})

async function connect(endpoint: string, identity: ConstructorParameters<typeof RpcClient>[0]['identity']) {
  const client = new RpcClient({ version: 'test', identity })
  clients.push(client)
  await client.attach(framePortOver(await dialLocal(endpoint), 'stream'))
  return client
}

async function until<T>(read: () => Promise<T | undefined> | T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe.skipIf(process.platform === 'win32')('daemon workspace', () => {
  it('serves the document, sessions and the cate API to clients and CLI callers', async () => {
    const result = await serveWorkspace({ root, home, lifecycle: createLifecycleBus(), log: createLogger('test') })
    if (result.kind !== 'serving') throw new Error('expected to serve')
    daemon = result.daemon
    const { endpoint } = daemon

    const client = await connect(endpoint, {
      client: { clientId: 'c1', device: { name: 'laptop', keyFingerprint: 'fp' }, features: [] },
    })
    const workspace = createCapabilityProxy(client, workspaceCapability)
    const document = createCapabilityProxy(client, documentCapability)
    const session = createCapabilityProxy(client, sessionCapability)
    const api = createCapabilityProxy(client, apiCapability)

    expect((await workspace.getTrust()).trusted).toBe(false)
    await workspace.setTrust({ trusted: true })

    const docEvents: unknown[] = []
    const docSub = document.subscribe({})
    docSub.onEvent((event) => docEvents.push(event))
    await until(() => (docEvents.length > 0 ? true : undefined))
    expect(docEvents[0]).toMatchObject({ kind: 'doc', seq: 0 })

    const op = {
      kind: 'addPanel',
      record: { id: 'term-1', type: 'terminal', title: 'Terminal 1', fields: {} },
      at: { to: 'stack', dock: { windowId: MAIN_WINDOW }, stackId: 's1' },
      opId: { clientId: 'c1', counter: 1 },
    } as DocOp
    await expect(document.apply({ op })).resolves.toMatchObject({ status: 'applied', seq: 1 })
    await until(() => (docEvents.some((e) => (e as { kind: string }).kind === 'op') ? true : undefined))

    // The session started a PTY; its snapshot says so.
    const sub = session.subscribe({ panelId: 'term-1' })
    let state: Record<string, unknown> = {}
    sub.onEvent((event) => {
      const e = event as ChannelEvent<Record<string, unknown>, Record<string, unknown>>
      state = e.kind === 'snapshot' ? e.snapshot : { ...state, ...e.change }
    })
    await until(() => (state.status === 'running' ? true : undefined))

    const list = await api.call({ method: 'cate.panel.list' }) as { panelId: string; type: string }[]
    expect(list).toEqual([expect.objectContaining({ panelId: 'term-1', type: 'terminal', title: 'Terminal 1' })])

    // The PTY's env carries a CLI token naming its panel.
    await api.call({ method: 'cate.terminal.type', args: { panelId: 'term-1', text: `printf '%s%s\\n' TOK= "$CATE_TOKEN"` } })
    await api.call({ method: 'cate.terminal.press', args: { panelId: 'term-1', keys: 'enter' } })
    const token = await until(async () => {
      const read = await api.call({ method: 'cate.terminal.read', args: { panelId: 'term-1' } }) as { text: string }
      return /TOK=([A-Za-z0-9_-]{20,})/.exec(read.text)?.[1]
    })

    const cli = await connect(endpoint, { caller: { token } })
    const cliApi = createCapabilityProxy(cli, apiCapability)
    await expect(cliApi.call({ method: 'cate.version' })).resolves.toEqual(expect.any(Number))
    // Read access through the CLI is on by default.
    const rows = await cliApi.call({ method: 'cate.panel.list' }) as { panelId: string }[]
    expect(rows.map((row) => row.panelId)).toEqual(['term-1'])

    // `cate notify` from the terminal reaches clients as a notification.
    const notified: unknown[] = []
    const notifications = createCapabilityProxy(client, agentsCapability).notifications()
    notifications.onEvent((event) => notified.push(event))
    await new Promise((r) => setTimeout(r, 50))
    await cliApi.call({ method: 'cate.ui.notify', args: { message: 'built' } })
    await until(() => (notified.length > 0 ? true : undefined))
    expect(notified[0]).toEqual({ kind: 'cate.ui.notify', panelId: 'term-1', title: 'Cate', body: 'built', level: 'info' })

    notifications.cancel()
    docSub.cancel()
    sub.cancel()
  }, 30_000)

  it('refuses a caller with an unknown token', async () => {
    const result = await serveWorkspace({ root, home, lifecycle: createLifecycleBus(), log: createLogger('test') })
    if (result.kind !== 'serving') throw new Error('expected to serve')
    daemon = result.daemon
    await expect(connect(daemon.endpoint, { caller: { token: 'nope' } })).rejects.toThrow()
  })
})
