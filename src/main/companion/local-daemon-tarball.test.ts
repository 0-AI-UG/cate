import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { CompanionManager } from './companionManager'
import { LocalSubprocessTransport } from './transports/localTransport'
import { hostCompanionTarget, tarballName } from './companionArtifacts'
import { COMPANION_VERSION } from '../../companion/version'
import { addAllowedRoot, removeAllowedRoot } from '../ipc/pathValidation'

// Provision the REAL per-target companion tarball locally and run the daemon
// through its OWN bundled node (runtime/bin/node), not Electron-as-node. This is
// the load-bearing check for "local = just another companion host": it proves the
// tarball's node + its bundled node-pty prebuild are ABI-compatible enough to
// spawn a PTY. Skips when the host tarball hasn't been built (`npm run
// companion:tarball`), so CI without the artifact doesn't fail.
const target = hostCompanionTarget()
const tarballPath = target
  ? path.resolve(process.cwd(), 'dist-companion', tarballName(COMPANION_VERSION, target))
  : ''
const hasTarball = !!tarballPath && existsSync(tarballPath)

describe.skipIf(!hasTarball)('local daemon from the real tarball', () => {
  let mgr: CompanionManager
  let installDir: string
  let workspace: string

  beforeAll(async () => {
    installDir = await fs.mkdtemp(path.join(process.cwd(), 'cate-local-install-'))
    workspace = await fs.realpath(await fs.mkdtemp(path.join(process.cwd(), 'cate-local-ws-')))
    addAllowedRoot(workspace)
    await fs.writeFile(path.join(workspace, 'hello.ts'), 'export const x = 1\n')
  }, 60_000)

  afterAll(async () => {
    await mgr?.disposeAll()
    removeAllowedRoot(workspace)
    await fs.rm(installDir, { recursive: true, force: true })
    await fs.rm(workspace, { recursive: true, force: true })
  })

  test('provisions, runs the daemon on the tarball node, serves fs + a PTY', async () => {
    mgr = new CompanionManager()
    const transport = new LocalSubprocessTransport({
      root: workspace,
      id: 'srv_localtarball',
      tarballPath,
      installDir,
    })

    // install=true so connect() runs bootstrap (extracts the tarball) before launch.
    const companion = await mgr.connect('srv_localtarball', transport, { install: true })

    // The daemon ran from the extracted tarball's own node.
    expect(existsSync(path.join(installDir, 'companion.cjs'))).toBe(true)
    expect(existsSync(path.join(installDir, 'pi', 'dist', 'cli.js'))).toBe(true)

    // fs over the wire.
    const dir = await companion.validatePathStrict(workspace)
    const tree = await companion.file.readDir(dir)
    expect(tree.map((n) => n.name)).toContain('hello.ts')

    // PTY: node-pty's bundled prebuild must load + spawn under the tarball node.
    const sawData = new Promise<void>((resolve) => {
      void companion.process.create(
        { cols: 80, rows: 24, cwd: dir, id: 'pty-1' },
        () => resolve(), // any output proves the shell spawned
        () => {},
      ).then((handle) => {
        expect(handle.pid).toBeGreaterThan(0)
        companion.process.write(handle.id, 'echo cate-ok\n')
      })
    })
    await sawData
  }, 60_000)
})
