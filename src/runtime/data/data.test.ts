import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bytesToHex } from '../security/contract'
import { isRuntimeId, runtimeIdFromCanonicalRoot } from './contract'
import {
  acquireRuntimeSocket,
  dataPaths,
  ensureDataDir,
  ensureRuntimeKeyPair,
  openSecretsFile,
  readRuntimeInfo,
  writeRuntimeInfo,
} from './runtime'
import { ensureLocalEndpointFor, localEndpoint, localEndpointFor, runtimeIdFor, shortSocketDir, workspaceDataDir } from './node'

let tmp: string
const servers: net.Server[] = []

beforeEach(async () => {
  // Short prefix: Unix socket paths are limited to ~104 bytes on macOS.
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cd-')))
})

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve))
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('runtimeId', () => {
  it('is 16 lowercase base32 characters and stable', () => {
    const id = runtimeIdFromCanonicalRoot('/Users/me/project')
    expect(isRuntimeId(id)).toBe(true)
    expect(runtimeIdFromCanonicalRoot('/Users/me/project')).toBe(id)
    expect(runtimeIdFromCanonicalRoot('/Users/me/project2')).not.toBe(id)
  })

  it('resolves symlinks and relative segments to the same id', async () => {
    const root = path.join(tmp, 'project')
    await fs.mkdir(root)
    await fs.symlink(root, path.join(tmp, 'link'))
    const id = await runtimeIdFor(root)
    expect(await runtimeIdFor(path.join(tmp, 'link'))).toBe(id)
    expect(await runtimeIdFor(path.join(root, '..', 'project'))).toBe(id)
    expect(id).toBe(runtimeIdFromCanonicalRoot(root))
  })
})

describe('workspace data directory', () => {
  it('lives under ~/.cate/workspaces/<runtimeId> and is created 0700', async () => {
    const dir = workspaceDataDir('abcdefghijklmnop', tmp)
    expect(dir).toBe(path.join(tmp, '.cate', 'workspaces', 'abcdefghijklmnop'))
    const paths = await ensureDataDir(dir)
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700)
    expect(paths.socket).toBe(path.join(dir, 'runtime.sock'))
    expect(paths.session('panel-1')).toBe(path.join(dir, 'sessions', 'panel-1.json'))
    expect(() => paths.session('../x')).toThrow()
    expect(localEndpoint(dir, 'abcdefghijklmnop', 'win32')).toBe('\\\\.\\pipe\\cate-abcdefghijklmnop')
    expect(localEndpointFor('abcdefghijklmnop', '/home/me', 'darwin')).toBe('/home/me/.cate/workspaces/abcdefghijklmnop/runtime.sock')
  })

  it('writes and reads runtime.json', async () => {
    const info = { runtimeId: 'abcdefghijklmnop', root: '/r', pid: 1, version: '2.0.0', protocol: [1, 0] as [number, number], endpoints: { local: '/r.sock' } }
    await writeRuntimeInfo(tmp, info)
    expect(await readRuntimeInfo(tmp)).toEqual(info)
  })

  it('creates the runtime key pair once, in a 0600 secrets.json, keeping other fields', async () => {
    await fs.writeFile(dataPaths(tmp).secrets, JSON.stringify({ browserPasswords: { a: 1 } }))
    const secrets = openSecretsFile(tmp)
    const first = await ensureRuntimeKeyPair(secrets)
    secrets.dispose()
    const reopened = openSecretsFile(tmp)
    const second = await ensureRuntimeKeyPair(reopened)
    reopened.dispose()
    expect(bytesToHex(second.publicKey)).toBe(bytesToHex(first.publicKey))
    expect((await fs.stat(dataPaths(tmp).secrets)).mode & 0o777).toBe(0o600)
    const onDisk = JSON.parse(await fs.readFile(dataPaths(tmp).secrets, 'utf8'))
    expect(onDisk.browserPasswords).toEqual({ a: 1 })
    expect(onDisk.runtimeKey.publicKey).toBe(bytesToHex(first.publicKey))
  })
})

describe.skipIf(process.platform === 'win32')('socket lock', () => {
  it('lets one of two contenders bind; the other sees it running', async () => {
    const results = await Promise.all([acquireRuntimeSocket(tmp, 'abcdefghijklmnop'), acquireRuntimeSocket(tmp, 'abcdefghijklmnop')])
    for (const result of results) if (result.kind === 'acquired') servers.push(result.server)
    expect(results.map((r) => r.kind).sort()).toEqual(['acquired', 'running'])
    expect((await fs.stat(dataPaths(tmp).socket)).mode & 0o777).toBe(0o600)
    const third = await acquireRuntimeSocket(tmp, 'abcdefghijklmnop')
    expect(third.kind).toBe('running')
  })

  it('removes a stale socket left by a dead daemon', async () => {
    const socket = dataPaths(tmp).socket
    const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(socket)}, () => console.log('up'))`])
    await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()))
    child.kill('SIGKILL')
    await new Promise((resolve) => child.once('exit', resolve))
    expect((await fs.lstat(socket)).isSocket()).toBe(true)

    const result = await acquireRuntimeSocket(tmp, 'abcdefghijklmnop')
    expect(result.kind).toBe('acquired')
    if (result.kind === 'acquired') servers.push(result.server)
    await new Promise<void>((resolve, reject) => net.connect(socket).once('connect', function (this: net.Socket) { this.destroy(); resolve() }).once('error', reject))
  })

  it('does not delete a non-socket file at the endpoint', async () => {
    await fs.writeFile(dataPaths(tmp).socket, 'keep')
    await expect(acquireRuntimeSocket(tmp, 'abcdefghijklmnop')).rejects.toThrow()
    expect(await fs.readFile(dataPaths(tmp).socket, 'utf8')).toBe('keep')
  })
})

describe.skipIf(process.platform === 'win32')('long home', () => {
  it('binds and dials through a short symlinked dir when the socket path is too long', async () => {
    const runtimeId = 'longhomeaaaaaaaa'
    const home = path.join(tmp, 'h'.repeat(60), 'u'.repeat(40))
    const dir = await ensureDataDir(workspaceDataDir(runtimeId, home))
    const link = path.join(shortSocketDir(), runtimeId)
    try {
      const expected = path.join(shortSocketDir(), runtimeId, 'runtime.sock')
      expect(localEndpointFor(runtimeId, home)).toBe(expected)
      const result = await acquireRuntimeSocket(dir.dir, runtimeId)
      expect(result).toMatchObject({ kind: 'acquired', endpoint: expected })
      if (result.kind === 'acquired') servers.push(result.server)
      // The socket file itself stays in the data dir.
      expect((await fs.lstat(dataPaths(dir.dir).socket)).isSocket()).toBe(true)
      expect((await fs.stat(shortSocketDir())).mode & 0o077).toBe(0)

      // A tmp cleaner removed the link: a dialer puts it back.
      await fs.rm(link)
      expect(await ensureLocalEndpointFor(runtimeId, home)).toBe(expected)
      await new Promise<void>((resolve, reject) => net.connect(expected).once('connect', function (this: net.Socket) { this.destroy(); resolve() }).once('error', reject))
      expect((await acquireRuntimeSocket(dir.dir, runtimeId)).kind).toBe('running')
    } finally {
      await fs.rm(link, { force: true })
    }
  })
})
