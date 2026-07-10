import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { addAllowedRoot, removeAllowedRoot, getAllowedRoots, clearFileGrantsForWindow, clearScopedWriteAllowancesForWindow } from '../ipc/pathValidation'
import { readDir, searchFiles } from '../ipc/filesystem'
import { RpcServer } from '../../runtime/rpcServer'
import { RUNTIME_PROTOCOL_VERSION } from '../../runtime/protocol'
import { RUNTIME_VERSION } from '../../runtime/version'
import { RuntimeRpcClient } from './rpcClient'
import { RemoteRuntime } from './RemoteRuntime'
import { buildDaemonRuntime } from '../../runtime/capabilities'
import { rgPath } from '@vscode/ripgrep'
import type { Runtime, FileHost, VcsHost, ProcessHost, AgentHost, ServerHost, TunnelHost } from './types'

/** The real daemon capability set over the wire — same FileHost/VcsHost the
 *  local workspace daemon hosts. rgPath is injected because tests don't run under
 *  the bundled runtime layout where rg sits beside the daemon's node binary. */
function daemonApi(): Runtime {
  return buildDaemonRuntime({ id: 'srv_test', rgPath }).runtime
}

const stubProcess = {} as unknown as ProcessHost
const stubAgent = {} as unknown as AgentHost
const stubServer = {} as unknown as ServerHost
const stubTunnel = {} as unknown as TunnelHost

// Wire an RpcServer and a RuntimeRpcClient back-to-back, in-process, over the
// real LF-JSON framing. This proves the entire wire stack (framing, req/res
// correlation, handshake, streaming, RemoteRuntime proxying) end to end —
// executing REAL fs/git on a temp dir — without needing SSH or WSL.
function loopback(api: Runtime): { remote: RemoteRuntime; client: RuntimeRpcClient; server: RpcServer } {
  // Forward reference: `server` closes over `client`, so it's declared first.
  // eslint-disable-next-line prefer-const
  let client!: RuntimeRpcClient
  const server = new RpcServer(api, (line) => client.handleChunk(line))
  client = new RuntimeRpcClient((line) => server.handleChunk(line))
  server.start()
  const remote = new RemoteRuntime('srv_test', client)
  return { remote, client, server }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

/** Drive a streaming searchContent to completion, collecting every batch. */
function collectSearch(
  remote: RemoteRuntime,
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

describe('runtime loopback (real daemon capabilities over the wire)', () => {
  let rootDir: string

  beforeEach(async () => {
    rootDir = await fs.realpath(await fs.mkdtemp(path.join(process.cwd(), 'cate-loopback-')))
    addAllowedRoot(rootDir, 'srv_test')
    await fs.writeFile(path.join(rootDir, 'alpha.ts'), 'const needle = 42\n')
    await fs.writeFile(path.join(rootDir, 'pic.bin'), Buffer.from([0, 1, 2, 3, 255]))
    await fs.mkdir(path.join(rootDir, 'sub'))
  })

  afterEach(async () => {
    removeAllowedRoot(rootDir, 'srv_test')
    await fs.rm(rootDir, { recursive: true, force: true })
  })

  test('handshake resolves with the daemon version + protocol', async () => {
    const { client } = loopback(daemonApi())
    const hello = await client.ready
    expect(hello.runtimeVersion).toBe(RUNTIME_VERSION)
    expect(hello.protocolVersion).toBe(RUNTIME_PROTOCOL_VERSION)
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

  test('vcs.findRepos discovers sub-repos one level down over the wire', async () => {
    const { remote } = loopback(daemonApi())
    // rootDir itself is not a repo; two children are, one plain folder is not.
    await fs.mkdir(path.join(rootDir, 'frontend'))
    await fs.mkdir(path.join(rootDir, 'backend'))
    await remote.vcs.init(path.join(rootDir, 'frontend'))
    await remote.vcs.init(path.join(rootDir, 'backend'))
    // `sub` (created in beforeEach) stays a non-repo folder.
    const repos = await remote.vcs.findRepos(rootDir)
    expect(repos.sort()).toEqual(
      [path.join(rootDir, 'backend'), path.join(rootDir, 'frontend')].sort(),
    )
  })

  test('write through the wire then read it back', async () => {
    const { remote } = loopback(daemonApi())
    const target = path.join(rootDir, 'written.txt')
    const safe = await remote.file.writeFile(target, 'hello from remote\n')
    expect(safe).toBe(target)
    expect(await fs.readFile(target, 'utf-8')).toBe('hello from remote\n')
  })

  test('extensionsRoot + extractArtifact round-trip over the wire (extension install)', async () => {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)
    const { remote } = loopback(daemonApi())

    // extensionsRoot returns a string over the wire (and registers itself as an
    // allowed root daemon-side). Point it at a temp dir so we don't touch ~/.cate.
    const hostRoot = path.join(rootDir, 'host-ext')
    process.env.CATE_EXTENSIONS_ROOT = hostRoot
    try {
      expect(await remote.file.extensionsRoot()).toBe(hostRoot)

      // Stage a tarball under the (allowed) rootDir, then extract it host-side
      // through the daemon — the path a real catalog install takes after the
      // client uploads the .tgz via writeBinary.
      const stage = path.join(rootDir, 'stage')
      await fs.mkdir(stage, { recursive: true })
      await fs.writeFile(path.join(stage, 'manifest.json'), JSON.stringify({ id: 'cate.x', name: 'X', panels: [] }))
      await fs.writeFile(path.join(stage, 'index.html'), '<title>wire</title>')
      const tgz = path.join(hostRoot, 'cate.x', '1.0.0.tgz')
      await fs.mkdir(path.dirname(tgz), { recursive: true })
      await execFileAsync('tar', ['-czf', tgz, '-C', stage, '.'])

      const dest = path.join(hostRoot, 'cate.x', '1.0.0')
      expect(await remote.file.extractArtifact(tgz, dest)).toBe(dest)
      expect(await remote.file.readFile(path.join(dest, 'index.html'))).toContain('<title>wire</title>')
    } finally {
      delete process.env.CATE_EXTENSIONS_ROOT
    }
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

    expect(getAllowedRoots('srv_test').has(extra)).toBe(false)
    await remote.addAllowedRoot(extra)
    expect(getAllowedRoots('srv_test').has(extra)).toBe(true)

    await remote.removeAllowedRoot(extra)
    expect(getAllowedRoots('srv_test').has(extra)).toBe(false)
  })

  test('setExclusions mutates the daemon set live so readDir hides the new name', async () => {
    const { remote } = loopback(daemonApi())
    await fs.writeFile(path.join(rootDir, 'a.ts'), 'a\n')
    await fs.writeFile(path.join(rootDir, 'ignoreme.log'), 'noise\n')
    const safe = await remote.validatePathStrict(rootDir)

    // No exclusions yet: both files show in the tree.
    const before = (await remote.file.readDir(safe)).map((n) => n.name)
    expect(before).toContain('a.ts')
    expect(before).toContain('ignoreme.log')

    // Push a live exclusion; the daemon's readDir closure sees the mutated set.
    await remote.setExclusions(['ignoreme.log'])
    const after = (await remote.file.readDir(safe)).map((n) => n.name)
    expect(after).toContain('a.ts')
    expect(after).not.toContain('ignoreme.log')
  })

  // FIX [7b]: per-window grant CLEARS round-trip so the daemon doesn't keep stale
  // per-window grants after the window closes.
  test('clearFileGrantsForWindow / clearScopedWriteAllowancesForWindow round-trip and revoke daemon grants', async () => {
    const { remote } = loopback(daemonApi())
    const outsideDir = await fs.realpath(await fs.mkdtemp(path.join(process.cwd(), 'cate-clear-')))
    const outsideFile = path.join(outsideDir, 'granted.txt')
    await fs.writeFile(outsideFile, 'secret\n')
    try {
      // Grant, confirm the daemon's authoritative strict check now passes.
      await remote.grantFileAccess(outsideFile, 7)
      await expect(remote.validatePathStrict(outsideFile, 7)).resolves.toBe(outsideFile)

      // Clear over the wire: the daemon drops the grant, so the check denies again.
      await remote.clearFileGrantsForWindow(7)
      await expect(remote.validatePathStrict(outsideFile, 7)).rejects.toThrow(/Access denied/)

      // A scoped write is authorized, executed, and consumed in one RPC.
      const createTarget = path.join(outsideDir, 'new.txt')
      await remote.registerScopedWriteAllowance(createTarget, 7)
      await expect(remote.file.writeFile(createTarget, 'created\n', { ownerWindowId: 7 })).resolves.toBe(createTarget)
      await expect(remote.file.writeFile(createTarget, 'again\n', { ownerWindowId: 7 })).rejects.toThrow(/Access denied/)

      // Explicit clearing still revokes an unused allowance.
      const clearedTarget = path.join(outsideDir, 'cleared.txt')
      await remote.registerScopedWriteAllowance(clearedTarget, 7)
      await remote.clearScopedWriteAllowancesForWindow(7)
      await expect(remote.file.writeFile(clearedTarget, 'nope\n', { ownerWindowId: 7 })).rejects.toThrow(/Access denied/)
    } finally {
      clearFileGrantsForWindow(7)
      clearScopedWriteAllowancesForWindow(7)
      await fs.rm(outsideDir, { recursive: true, force: true })
    }
  })

  // FIX [7c]: a live setExclusions rebuilds ACTIVE watchers, and the rebuilt
  // watcher keeps delivering events (the registry swap is correct). The exact
  // glob-ignore behavior of chokidar is shared with the in-process watcher and
  // not re-asserted here; what's new is that an active watcher is recreated
  // against the current exclusion set rather than left stale.
  test('setExclusions rebuilds active watchers and the rebuilt watcher still delivers events', async () => {
    const api = daemonApi()
    const { remote } = loopback(api)
    const safe = await remote.validatePathStrict(rootDir)

    const events: string[] = []
    const unsub = remote.file.watch(safe, (changedPath) => { events.push(path.basename(changedPath)) })
    await new Promise((r) => setTimeout(r, 300)) // let chokidar attach

    // Baseline: a write under the watched root produces an event.
    await fs.writeFile(path.join(rootDir, 'before.txt'), 'one\n')
    await waitFor(() => events.includes('before.txt'), 2000)

    // Live exclusion change: this closes + recreates the active watcher.
    await remote.setExclusions(['whatever'])
    await new Promise((r) => setTimeout(r, 300)) // let the rebuilt watcher attach
    events.length = 0

    // The rebuilt watcher is live and keeps delivering events for kept files.
    await fs.writeFile(path.join(rootDir, 'after.txt'), 'two\n')
    await waitFor(() => events.includes('after.txt'), 2000)

    // Unsubscribe stops events even right after a rebuild (registry handled it).
    unsub()
    await new Promise((r) => setTimeout(r, 200))
    events.length = 0
    await fs.writeFile(path.join(rootDir, 'post-unsub.txt'), 'three\n')
    await new Promise((r) => setTimeout(r, 400))
    expect(events).not.toContain('post-unsub.txt')

    await remote.setExclusions([])
  })
})

/** Poll a predicate until true or the timeout elapses. */
async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('runtime loopback (protocol behaviors via a stub)', () => {
  test('errors thrown on the daemon reject the client call with the message', async () => {
    const api = {
      id: 'srv_test',
      process: stubProcess,
      agent: stubAgent,
      server: stubServer,
      tunnel: stubTunnel,
      file: { readFile: async () => { throw new Error('boom on daemon') } } as unknown as FileHost,
      vcs: {} as VcsHost,
      validatePath: (p: string) => p,
      validatePathStrict: async (p: string) => p,
      validatePathForCreation: async (p: string) => p,
      validateCwd: (p: string) => p,
      addAllowedRoot: async () => {},
      removeAllowedRoot: async () => {},
      setExclusions: async () => {},
      setIdleSuspend: async () => {},
      grantFileAccess: async () => {},
      registerScopedWriteAllowance: async () => {},
      clearFileGrantsForWindow: async () => {},
      clearScopedWriteAllowancesForWindow: async () => {},
    } as Runtime
    const { remote } = loopback(api)
    await expect(remote.file.readFile('/x')).rejects.toThrow('boom on daemon')
  })

  test('file.watch streams events over evt frames and stops on unsubscribe', async () => {
    let emit: ((p: string) => void) | null = null
    const api = {
      id: 'srv_test',
      process: stubProcess,
      agent: stubAgent,
      server: stubServer,
      tunnel: stubTunnel,
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
      setExclusions: async () => {},
      setIdleSuspend: async () => {},
      grantFileAccess: async () => {},
      registerScopedWriteAllowance: async () => {},
      clearFileGrantsForWindow: async () => {},
      clearScopedWriteAllowancesForWindow: async () => {},
    } as Runtime

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
      server: stubServer,
      tunnel: stubTunnel,
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
      setExclusions: async () => {},
      setIdleSuspend: async () => {},
      grantFileAccess: async () => {},
      registerScopedWriteAllowance: async () => {},
      clearFileGrantsForWindow: async () => {},
      clearScopedWriteAllowancesForWindow: async () => {},
    } as Runtime

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
    const { client } = loopback(localRuntimeLike())
    await client.ready
    await expect(client.call('bogus.method')).rejects.toThrow(/Unknown runtime method/)
  })
})

function localRuntimeLike(): Runtime {
  return {
    id: 'srv_test',
    process: stubProcess,
    agent: stubAgent,
    server: stubServer,
    tunnel: stubTunnel,
    file: {} as FileHost,
    vcs: {} as VcsHost,
    validatePath: (p) => p,
    validatePathStrict: async (p) => p,
    validatePathForCreation: async (p) => p,
    validateCwd: (p) => p,
    addAllowedRoot: async () => {},
    removeAllowedRoot: async () => {},
    setExclusions: async () => {},
    setIdleSuspend: async () => {},
    grantFileAccess: async () => {},
    registerScopedWriteAllowance: async () => {},
    clearFileGrantsForWindow: async () => {},
    clearScopedWriteAllowancesForWindow: async () => {},
  }
}
