// Test helpers shared by the files tests: a files runtime over a temp
// workspace, served over an in-memory rpc connection, with a fake watcher the
// test drives.

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryPortPair } from '@kernel/rpc/contract'
import { RpcServer } from '@kernel/rpc/runtime'
import { RpcClient, createCapabilityProxy } from '@kernel/rpc/client'
import { dataPaths } from '@runtime/data/runtime'
import { fileCapability, searchCapability, type FsChangeType } from './contract'
import { createFilesRuntime, fileCapabilityImpl, searchCapabilityImpl, type FilesRuntimeDeps } from './runtime'
import { createFsClient } from './client'
import { createLifecycleBus } from '@kernel/lifecycle/contract'

type ParcelCb = (err: Error | null, events: Array<{ path: string; type: FsChangeType }>) => void

export function fakeWatcher() {
  const subs = new Set<{ root: string; cb: ParcelCb }>()
  return {
    deps: {
      subscribe: async (root: string, cb: ParcelCb) => {
        const sub = { root, cb }
        subs.add(sub)
        return { unsubscribe: async () => { subs.delete(sub) } }
      },
    } as unknown as NonNullable<FilesRuntimeDeps['watcher']>,
    fire(p: string, type: FsChangeType) {
      for (const sub of [...subs]) {
        if (p === sub.root || p.startsWith(sub.root + path.sep)) sub.cb(null, [{ path: p, type }])
      }
    },
    roots: () => [...subs].map((s) => s.root),
  }
}

export async function makeWorkspace(overrides: Partial<FilesRuntimeDeps> = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cate-files-')))
  const root = path.join(base, 'root')
  const data = path.join(base, 'data')
  await fs.mkdir(root, { recursive: true })
  await fs.mkdir(data, { recursive: true })
  const watcher = fakeWatcher()
  const deps: FilesRuntimeDeps = {
    root,
    dataPaths: dataPaths(data),
    watcher: watcher.deps,
    buffers: { persistDelayMs: 0, settleMs: 0 },
    ...overrides,
  }
  const files = createFilesRuntime(deps)
  const server = new RpcServer({ lifecycle: createLifecycleBus(), version: '1.0.0' })
  server.register(fileCapability, fileCapabilityImpl(files))
  server.register(searchCapability, searchCapabilityImpl(files))
  const clients: RpcClient[] = []

  const connect = async (clientId = `c${clients.length + 1}`) => {
    const client = new RpcClient({
      version: '1.0.0',
      identity: { client: { clientId, device: { name: 'test', keyFingerprint: 'fp' }, features: [] } },
    })
    const [serverPort, clientPort] = createMemoryPortPair()
    server.serve(serverPort)
    await client.attach(clientPort)
    clients.push(client)
    const file = createCapabilityProxy(client, fileCapability)
    const search = createCapabilityProxy(client, searchCapability)
    return { client, file, search, fs: createFsClient(file, search) }
  }

  const dispose = async () => {
    for (const client of clients) client.detach()
    server.close()
    await files.dispose()
    await fs.rm(base, { recursive: true, force: true })
  }

  return { base, root, data, files, watcher, connect, dispose, deps }
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time')
    await tick(5)
  }
}
