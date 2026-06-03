import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { addAllowedRoot, removeAllowedRoot, getAllowedRoots, clearFileGrantsForWindow } from '../ipc/pathValidation'
import { readDir, searchFiles } from '../ipc/filesystem'
import { RpcServer } from '../../companion/rpcServer'
import { COMPANION_PROTOCOL_VERSION } from '../../companion/protocol'
import { COMPANION_VERSION } from '../../companion/version'
import { CompanionRpcClient } from './rpcClient'
import { RemoteCompanion } from './RemoteCompanion'
import { buildDaemonCompanion } from '../../companion/capabilities'
import { rgPath } from '@vscode/ripgrep'
import type { Companion, FileHost, VcsHost, ProcessHost, AgentHost } from './types'

/** The real daemon capability set over the wire — same FileHost/VcsHost the
 *  local workspace daemon hosts. rgPath is injected because tests don't run under
 *  the bundled runtime layout where rg sits beside the daemon's node binary. */
function daemonApi(): Companion {
  return buildDaemonCompanion({ id: 'srv_test', rgPath }).companion
}

const stubProcess = {} as unknown as ProcessHost
const stubAgent = {} as unknown as AgentHost

// Wire an RpcServer and a CompanionRpcClient back-to-back, in-process, over the
// real LF-JSON framing. This proves the entire wire stack (framing, req/res
// correlation, handshake, streaming, RemoteCompanion proxying) end to end —
// executing REAL fs/git on a temp dir — without needing SSH or WSL.
function loopback(api: Companion): { remote: RemoteCompanion; client: CompanionRpcClient; server: RpcServer } {
  let client!: CompanionRpcClient
  const server = new RpcServer(api, (line) => client.handleChunk(line))
  client = new CompanionRpcClient((line) => server.handleChunk(line))
  server.start()
  const remote = new RemoteCompanion('srv_test', client)
  return { remote, client, server }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

/** Drive a streaming searchContent to completion, collecting every batch. */
function collectSearch(
  remote: RemoteCompanion,
  root: string,
  opts: import('../../shared/types').SearchOptions,
): Promise<{ files: import('../../shared/types').SearchFileResult[]; stats: import('../../shared/types').SearchStats; error?: string }> {
  return new Promise((resolve) => {
    const files: import('../../shared/types').SearchFileResult[] = []
    remote.file.searchContent(root, opts, {
      onBatch: (b) => files.push(...b),
      onDone: (stats, error) => resolve({ files, stats, error }),
    })
  })
}

describe('companion loopback (real daemon capabilities over the wire)', () => {
  let rootDir: string

  beforeEach(async () => {
    rootDir = await fs.realpath(await fs.mkdtemp(path.join(process.cwd(), 'cate-loopback-')))
    addAllowedRoot(rootDir)
    await fs.writeFile(path.join(rootDir, 'alpha.ts'), 'const needle = 42\n')
    await fs.writeFile(path.join(rootDir, 'pic.bin'), Buffer.from([0, 1, 2, 3, 255]))
    await fs.mkdir(path.join(rootDir, 'sub'))
  })

  afterEach(async () => {
    removeAllowedRoot(rootDir)
    await fs.rm(rootDir, { recursive: true, force: true })
  })

  test('handshake resolves with the daemon version + protocol', async () => {
    const { client } = loopback(daemonApi())
    const hello = await client.ready
    expect(hello.companionVersion).toBe(COMPANION_VERSION)
    expect(hello.protocolVersion).toBe(COMPANION_PROTOCOL_VERSION)
  })

  test('ping round-trips', async () => {
    const { client } = loopback(daemonApi())
    await client.ready
    expect(await client.call('ping')).toBe('pong')
  })

  test('file.readDir over the wire matches the local function', async () => {
    const { remote } = loopback(daemonApi())
    const safe = await remote.validatePathStrict(rootDir)
    const viaRemote = await remote.file.readDir(safe)
    const direct = await readDir(safe)
    expect(viaRemote).toEqual(direct)
    expect(viaRemote.map((n) => n.name)).toContain('alpha.ts')
  })

  test('file.readFile + file.stat over the wire', async () => {
    const { remote } = loopback(daemonApi())
    const file = await remote.validatePathStrict(path.join(rootDir, 'alpha.ts'))
    expect(await remote.file.readFile(file)).toBe('const needle = 42\n')
    expect(await remote.file.stat(file)).toEqual({ isDirectory: false, isFile: true })
  })

  test('file.readBinary survives base64 transit', async () => {
    const { remote } = loopback(daemonApi())
    const file = await remote.validatePathStrict(path.join(rootDir, 'pic.bin'))
    const buf = await remote.file.readBinary(file)
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect([...buf]).toEqual([0, 1, 2, 3, 255])
  })

  test('file.search over the wire matches the local function', async () => {
    const { remote } = loopback(daemonApi())
    const safe = await remote.validatePathStrict(rootDir)
    const viaRemote = await remote.file.search(safe, 'needle')
    const direct = await searchFiles(safe, 'needle')
    expect(viaRemote).toEqual(direct)
  })

  test('file.searchContent streams ripgrep results over the wire', async () => {
    const { remote } = loopback(daemonApi())
    const safe = await remote.validatePathStrict(rootDir)
    const { files, stats, error } = await collectSearch(remote, safe, { query: 'needle' })
    expect(error).toBeUndefined()
    expect(stats.matches).toBe(1)
    const hit = files.find((f) => f.relativePath === 'alpha.ts')
    expect(hit).toBeTruthy()
    expect(hit!.lines[0].text).toContain('needle')
  })

  test('vcs.isRepo + vcs.status + vcs.init over the wire', async () => {
    const { remote } = loopback(daemonApi())
    expect(await remote.vcs.isRepo(rootDir)).toBe(false)
    await remote.vcs.init(rootDir)
    expect(await remote.vcs.isRepo(rootDir)).toBe(true)
    const status = await remote.vcs.status(rootDir)
    expect(Array.isArray(status.files)).toBe(true)
    // alpha.ts + pic.bin + sub are untracked in the fresh repo.
    expect(status.files.some((f) => f.path === 'alpha.ts')).toBe(true)
  })

  test('write through the wire then read it back', async () => {
    const { remote } = loopback(daemonApi())
    const target = path.join(rootDir, 'written.txt')
    const safe = await remote.validatePathForCreation(target)
    await remote.file.writeFile(safe, 'hello from remote\n')
    expect(await fs.readFile(target, 'utf-8')).toBe('hello from remote\n')
  })

  test('grantFileAccess round-trips so the daemon allows an out-of-root file', async () => {
    const { remote } = loopback(daemonApi())
    // A file OUTSIDE any allowed root (not under rootDir, not under tmpdir): the
    // daemon's strict validation must reject it until the grant is forwarded.
    const outsideDir = await fs.realpath(await fs.mkdtemp(path.join(process.cwd(), 'cate-grant-')))
    const outsideFile = path.join(outsideDir, 'granted.txt')
    await fs.writeFile(outsideFile, 'secret\n')
    try {
      await expect(remote.validatePathStrict(outsideFile, 1)).rejects.toThrow(/Access denied/)
      await remote.grantFileAccess(outsideFile, 1)
      // Same window id now passes the daemon's authoritative strict check.
      await expect(remote.validatePathStrict(outsideFile, 1)).resolves.toBe(outsideFile)
      // A different window without the grant is still denied.
      await expect(remote.validatePathStrict(outsideFile, 2)).rejects.toThrow(/Access denied/)
    } finally {
      clearFileGrantsForWindow(1)
      await fs.rm(outsideDir, { recursive: true, force: true })
    }
  })

  test('addAllowedRoot / removeAllowedRoot round-trip over the wire', async () => {
    const { remote } = loopback(daemonApi())
    const extra = path.resolve(rootDir, 'extra-root')

    expect(getAllowedRoots().has(extra)).toBe(false)
    await remote.addAllowedRoot(extra)
    expect(getAllowedRoots().has(extra)).toBe(true)

    await remote.removeAllowedRoot(extra)
    expect(getAllowedRoots().has(extra)).toBe(false)
  })
})

describe('companion loopback (protocol behaviors via a stub)', () => {
  test('errors thrown on the daemon reject the client call with the message', async () => {
    const api = {
      id: 'srv_test',
      process: stubProcess,
      agent: stubAgent,
      file: { readFile: async () => { throw new Error('boom on daemon') } } as unknown as FileHost,
      vcs: {} as VcsHost,
      validatePath: (p: string) => p,
      validatePathStrict: async (p: string) => p,
      validatePathForCreation: async (p: string) => p,
      validateCwd: (p: string) => p,
      addAllowedRoot: async () => {},
      removeAllowedRoot: async () => {},
      grantFileAccess: async () => {},
      registerScopedWriteAllowance: async () => {},
    } as Companion
    const { remote } = loopback(api)
    await expect(remote.file.readFile('/x')).rejects.toThrow('boom on daemon')
  })

  test('file.watch streams events over evt frames and stops on unsubscribe', async () => {
    let emit: ((p: string) => void) | null = null
    const api = {
      id: 'srv_test',
      process: stubProcess,
      agent: stubAgent,
      file: {
        watch: (_prefix: string, onChange: (p: string) => void) => {
          emit = onChange
          return () => { emit = null }
        },
      } as unknown as FileHost,
      vcs: {} as VcsHost,
      validatePath: (p: string) => p,
      validatePathStrict: async (p: string) => p,
      validatePathForCreation: async (p: string) => p,
      validateCwd: (p: string) => p,
      addAllowedRoot: async () => {},
      removeAllowedRoot: async () => {},
      grantFileAccess: async () => {},
      registerScopedWriteAllowance: async () => {},
    } as Companion

    const { remote } = loopback(api)
    const seen: string[] = []
    const unsubscribe = remote.file.watch('/root', (p) => seen.push(p))

    await flush() // let the watch.start round-trip register the stream
    expect(emit).toBeTypeOf('function')
    emit!('/root/changed.ts')
    await flush()
    expect(seen).toEqual(['/root/changed.ts'])

    unsubscribe()
    await flush()
    expect(emit).toBeNull() // daemon-side subscription torn down
  })

  test('file.searchContent streams batches over evt frames and cancel tears down the daemon search', async () => {
    let callbacks: { onBatch: (f: unknown[]) => void; onDone: (s: unknown, e?: string) => void } | null = null
    let cancelled = false
    const api = {
      id: 'srv_test',
      process: stubProcess,
      agent: stubAgent,
      file: {
        searchContent: (_root: string, _opts: unknown, cbs: typeof callbacks) => {
          callbacks = cbs
          return { cancel: () => { cancelled = true } }
        },
      } as unknown as FileHost,
      vcs: {} as VcsHost,
      validatePath: (p: string) => p,
      validatePathStrict: async (p: string) => p,
      validatePathForCreation: async (p: string) => p,
      validateCwd: (p: string) => p,
      addAllowedRoot: async () => {},
      removeAllowedRoot: async () => {},
      grantFileAccess: async () => {},
      registerScopedWriteAllowance: async () => {},
    } as Companion

    const { remote } = loopback(api)
    const seen: unknown[] = []
    const handle = remote.file.searchContent('/root', { query: 'x' }, {
      onBatch: (f) => seen.push(...f),
      onDone: () => {},
    })

    await flush() // let the searchContent.start round-trip register the stream
    expect(callbacks).toBeTruthy()
    callbacks!.onBatch([{ path: '/root/a.ts', relativePath: 'a.ts', lines: [], matchCount: 1 }])
    await flush()
    expect(seen).toHaveLength(1)

    handle.cancel()
    await flush()
    expect(cancelled).toBe(true) // daemon-side search torn down
  })

  test('an unknown method rejects', async () => {
    const { client } = loopback(localCompanionLike())
    await client.ready
    await expect(client.call('bogus.method')).rejects.toThrow(/Unknown companion method/)
  })
})

function localCompanionLike(): Companion {
  return {
    id: 'srv_test',
    process: stubProcess,
    agent: stubAgent,
    file: {} as FileHost,
    vcs: {} as VcsHost,
    validatePath: (p) => p,
    validatePathStrict: async (p) => p,
    validatePathForCreation: async (p) => p,
    validateCwd: (p) => p,
    addAllowedRoot: async () => {},
    removeAllowedRoot: async () => {},
    grantFileAccess: async () => {},
    registerScopedWriteAllowance: async () => {},
  }
}
