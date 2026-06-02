import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { build } from 'esbuild'
import { CompanionManager } from './companionManager'
import { LocalSubprocessTransport } from './transports/localTransport'
import { addAllowedRoot, removeAllowedRoot } from '../ipc/pathValidation'

// End-to-end through a REAL subprocess: esbuild-bundle the daemon, spawn it with
// plain Node, and drive it via RemoteCompanion over actual OS stdio pipes. This
// proves the daemon entry + electron-free capabilities + LocalSubprocessTransport
// + the bundle all work together — the strongest verification short of a remote
// host. (SSH/WSL differ only in how the same bundle is launched.)

let bundlePath: string
let buildDir: string

beforeAll(async () => {
  // Build UNDER the repo so the spawned daemon resolves externalized native
  // deps (node-pty) from the repo's node_modules.
  buildDir = await fs.mkdtemp(path.join(process.cwd(), 'cate-daemon-build-'))
  bundlePath = path.join(buildDir, 'companion.cjs')
  await build({
    entryPoints: [path.resolve(__dirname, '../../companion/index.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: bundlePath,
    external: ['fsevents', 'node-pty', 'electron'],
    logLevel: 'silent',
  })
}, 60_000)

afterAll(async () => {
  await fs.rm(buildDir, { recursive: true, force: true })
})

describe('cate-companion daemon (real subprocess)', () => {
  let mgr: CompanionManager
  let workspace: string

  beforeAll(async () => {
    // The daemon sandboxes to --root; on the client side we also allow it so the
    // client-side lexical checks (if any) agree. The daemon process has its own.
    workspace = await fs.realpath(await fs.mkdtemp(path.join(process.cwd(), 'cate-daemon-ws-')))
    addAllowedRoot(workspace)
    await fs.writeFile(path.join(workspace, 'hello.ts'), 'export const x = 1\n')
    await fs.mkdir(path.join(workspace, 'pkg'))
    await fs.writeFile(path.join(workspace, 'pkg', 'data.bin'), Buffer.from([9, 8, 7, 0, 255]))
  })

  afterAll(async () => {
    await mgr?.disposeAll()
    removeAllowedRoot(workspace)
    await fs.rm(workspace, { recursive: true, force: true })
  })

  test('connects, reads, and runs git over a real pipe', async () => {
    mgr = new CompanionManager()
    const transport = new LocalSubprocessTransport({
      nodePath: process.execPath,
      bundlePath,
      root: workspace,
      id: 'srv_subproc',
    })
    const companion = await mgr.connect('srv_subproc', transport)

    // file ops
    const dir = await companion.validatePathStrict(workspace)
    const tree = await companion.file.readDir(dir)
    expect(tree.map((n) => n.name).sort()).toEqual(['hello.ts', 'pkg'])

    const file = await companion.validatePathStrict(path.join(workspace, 'hello.ts'))
    expect(await companion.file.readFile(file)).toBe('export const x = 1\n')

    const bin = await companion.validatePathStrict(path.join(workspace, 'pkg', 'data.bin'))
    expect([...(await companion.file.readBinary(bin))]).toEqual([9, 8, 7, 0, 255])

    // write through the daemon, read back on this side
    const target = await companion.validatePathForCreation(path.join(workspace, 'written.txt'))
    await companion.file.writeFile(target, 'from the daemon\n')
    expect(await fs.readFile(path.join(workspace, 'written.txt'), 'utf-8')).toBe('from the daemon\n')

    // writeBinary over the wire (base64-encoded both ways): raw bytes round-trip.
    const bytes = Buffer.from([0, 1, 2, 250, 251, 255])
    const binTarget = await companion.validatePathForCreation(path.join(workspace, 'blob.bin'))
    await companion.file.writeBinary(binTarget, bytes)
    expect([...(await fs.readFile(path.join(workspace, 'blob.bin')))]).toEqual([...bytes])
    expect([...(await companion.file.readBinary(binTarget))]).toEqual([...bytes])

    // git ops
    expect(await companion.vcs.isRepo(workspace)).toBe(false)
    await companion.vcs.init(workspace)
    expect(await companion.vcs.isRepo(workspace)).toBe(true)
    const status = await companion.vcs.status(workspace)
    expect(status.files.some((f) => f.path === 'hello.ts')).toBe(true)
  }, 30_000)

  // POSIX-only: the daemon's resolveShell falls back through $SHELL → /bin/bash →
  // /bin/sh, which don't exist on a native Windows host. In production the daemon
  // only ever runs on POSIX (SSH → Linux/macOS, WSL → Linux inside the distro);
  // the local Windows machine uses the Electron-side terminal, not this daemon.
  test.skipIf(process.platform === 'win32')(
    'spawns a real PTY on the daemon and streams its output over the wire',
    async () => {
      mgr = new CompanionManager()
      const transport = new LocalSubprocessTransport({
        nodePath: process.execPath,
        bundlePath,
        root: workspace,
        id: 'srv_pty',
      })
      const companion = await mgr.connect('srv_pty', transport)

      let output = ''
      const sawMarker = new Promise<void>((resolve, reject) => {
        companion.process
          .create(
            { cols: 80, rows: 24, cwd: workspace, shell: '/bin/sh' },
            (_id, data) => {
              output += data
              if (output.includes('CATE_REMOTE_PTY_OK')) resolve()
            },
            () => { /* exit */ },
          )
          .then((handle) => {
            // Write a command into the remote shell; its echo + output stream back.
            companion.process.write(handle.id, 'echo CATE_REMOTE_PTY_OK\n')
          })
          // Surface a spawn failure instead of letting it time out with empty output.
          .catch(reject)
      })

      await Promise.race([
        sawMarker,
        new Promise((_r, reject) => setTimeout(() => reject(new Error(`no marker; got: ${output.slice(0, 200)}`)), 8000)),
      ])
      expect(output).toContain('CATE_REMOTE_PTY_OK')
    },
    30_000,
  )

  test('streams remote filesystem changes over the wire', async () => {
    mgr = new CompanionManager()
    const transport = new LocalSubprocessTransport({
      nodePath: process.execPath,
      bundlePath,
      root: workspace,
      id: 'srv_watch',
    })
    const companion = await mgr.connect('srv_watch', transport)

    const changes: string[] = []
    const sawChange = new Promise<void>((resolve) => {
      companion.file.watch(workspace, (p) => {
        changes.push(p)
        if (p.includes('fresh.txt')) resolve()
      })
    })

    // Give the daemon's chokidar a moment to initialize, then create a file.
    await new Promise((r) => setTimeout(r, 400))
    await fs.writeFile(path.join(workspace, 'fresh.txt'), 'new\n')

    await Promise.race([
      sawChange,
      new Promise((_r, reject) => setTimeout(() => reject(new Error(`no fs event; got: ${JSON.stringify(changes)}`)), 6000)),
    ])
    expect(changes.some((c) => c.includes('fresh.txt'))).toBe(true)
  }, 30_000)
})
