// Builds the real daemon bundle and starts it the way the desktop shell does:
// one detached `node runtime.cjs serve <root>`, then dial until it answers.

import { afterAll, beforeAll, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { framePortOver } from '@kernel/rpc/contract'
import { RpcClient, createCapabilityProxy } from '@kernel/rpc/client'
import { RUNTIME_VERSION, runtimeCapability } from '../contract'
import { processCapability } from '@services/terminal/contract'
import { workspaceCapability } from '@workspace/lifecycle/contract'
import { startLocalRuntime } from './startLocal'

const repoRoot = path.resolve(__dirname, '../../../..')
// Inside the repo so the bundle's external native modules still resolve.
const bundle = path.join(repoRoot, 'dist-runtime', `cate-runtime-test-${process.pid}`, 'runtime.cjs')
let tmp: string

beforeAll(async () => {
  const { buildRuntime } = await import(path.join(repoRoot, 'scripts', 'build-runtime.mjs'))
  await buildRuntime(bundle)
  tmp = fs.mkdtempSync('/tmp/cate-s-')
}, 30_000)

afterAll(() => {
  fs.rmSync(path.dirname(bundle), { recursive: true, force: true })
  fs.rmSync(tmp, { recursive: true, force: true })
})

it.skipIf(process.platform === 'win32')('starts the runtime when nothing answers, then reuses it', async () => {
  const home = path.join(tmp, 'h')
  const root = path.join(tmp, 'w')
  fs.mkdirSync(home)
  fs.mkdirSync(root)
  const options = { root, home, launch: { node: process.execPath, bundle }, env: { ...process.env, HOME: home } }

  const first = await startLocalRuntime(options)
  expect(first.started).toBe(true)
  const client = new RpcClient({ version: RUNTIME_VERSION, identity: { client: { clientId: 'c', device: { name: 'd', publicKey: 'f' }, features: [] } } })
  await client.attach(framePortOver(first.duplex, 'stream'))
  const runtime = createCapabilityProxy(client, runtimeCapability)
  try {
    const info = await runtime.info()
    expect(info.runtimeId).toBe(first.runtimeId)
    expect(info.pid).not.toBe(process.pid)

    // Exercise the real native addon through the split production build.
    // macOS' spawn helper reports a missing program as a child exit.
    await createCapabilityProxy(client, workspaceCapability).setTrust({ trusted: true })
    const terminal = createCapabilityProxy(client, processCapability)
    const missing = await terminal.spawn({ cols: 80, rows: 24, launch: {
      kind: 'command', params: { executable: '/cate-round2-no-such-command', args: [] },
    } })
    await waitFor(async () => !(await terminal.list()).find((entry) => entry.id === missing.id)?.alive)
    expect((await runtime.info()).pid).toBe(info.pid)

    const second = await startLocalRuntime(options)
    expect(second.started).toBe(false)
    second.duplex.close()

  } finally {
    await runtime.stop().catch(() => {})
    client.close()
  }
  await waitFor(() => !fs.existsSync(first.endpoint))
  expect(fs.readFileSync(path.join(home, '.cate', 'workspaces', first.runtimeId, 'logs', 'daemon.log'), 'utf-8'))
    .toMatch(/stopping \(stop\)/)
}, 30_000)

async function waitFor(check: () => boolean | Promise<boolean>, budgetMs = 5000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}
