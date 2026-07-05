// =============================================================================
// Extension install/serve, end to end against a REAL runtime daemon SUBPROCESS
// (not the in-process buildDaemonRuntime the unit tests use). The daemon runs
// from the built tarball on its own bundled node, reached over real stdio
// JSON-RPC — the same wire a remote (SSH/WSL) host uses. We give it a NON-local
// id ('srv_e2e') and point its extensions root at a temp dir via the daemon's
// env, so this exercises the exact path a remote workspace takes:
//
//   provisionCatalogToRuntime: stage the .tgz on the "client" -> file.writeBinary
//   it to the host -> file.extractArtifact (host-side untar) -> serve assets via
//   file.readBinary -> storage round-trips through file.writeFile/readFile.
//
// Skips when the host tarball hasn't been built (`npm run runtime:tarball`), so a
// CI without the artifact stays green. This is the load-bearing "remote actually
// works" check the in-process tests can't make.
// =============================================================================

import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

// download.ts (client staging) reads userData via electron's app; provide a temp
// one. The runtime modules don't touch electron, so this mock is inert for them.
const h = vi.hoisted(() => ({ userData: '', appPath: '' }))
vi.mock('electron', () => ({ app: { getPath: () => h.userData, getAppPath: () => h.appPath } }))

import { RuntimeManager } from '../runtime/runtimeManager'
import { LocalSubprocessTransport } from '../runtime/transports/localTransport'
import { hostRuntimeTarget, tarballName } from '../runtime/runtimeArtifacts'
import { RUNTIME_VERSION } from '../../runtime/version'
import { addAllowedRoot, removeAllowedRoot } from '../ipc/pathValidation'
import { provisionCatalogToRuntime } from './install'
import type { CatalogEntry } from './catalog'
import type { Runtime } from '../runtime/types'

const target = hostRuntimeTarget()
const tarballPath = target
  ? path.resolve(process.cwd(), 'dist-runtime', tarballName(RUNTIME_VERSION, target))
  : ''
const hasTarball = !!tarballPath && existsSync(tarballPath)

const EXT_ID = 'cate.e2e'
const EXT_VERSION = '2.0.0'

describe.skipIf(!hasTarball)('extension install/serve over a real daemon subprocess', () => {
  let mgr: RuntimeManager
  let installDir: string
  let workspace: string
  let hostExtRoot: string
  let entry: CatalogEntry
  let runtime: Runtime

  beforeAll(async () => {
    installDir = await fs.mkdtemp(path.join(process.cwd(), 'cate-exte2e-install-'))
    workspace = await fs.realpath(await fs.mkdtemp(path.join(process.cwd(), 'cate-exte2e-ws-')))
    // The daemon resolves its extensions root from CATE_EXTENSIONS_ROOT (env),
    // pointed at a temp dir so the test never touches the real ~/.cate.
    hostExtRoot = await fs.realpath(await fs.mkdtemp(path.join(process.cwd(), 'cate-exte2e-hostext-')))
    h.userData = await fs.mkdtemp(path.join(process.cwd(), 'cate-exte2e-userdata-')) // client staging cache
    h.appPath = process.cwd()
    addAllowedRoot(workspace)

    // Build a minimal extension artifact (manifest + an asset) as a .tgz.
    const src = await fs.mkdtemp(path.join(process.cwd(), 'cate-exte2e-src-'))
    await fs.writeFile(
      path.join(src, 'manifest.json'),
      JSON.stringify({ id: EXT_ID, name: 'E2E', version: EXT_VERSION, panels: [{ id: 'm', label: 'M' }], frontend: 'index.html' }),
    )
    await fs.writeFile(path.join(src, 'index.html'), '<!doctype html><title>e2e-asset</title>')
    const tgz = path.join(process.cwd(), `cate.e2e-${EXT_VERSION}.tgz`)
    execFileSync('tar', ['-czf', tgz, '-C', src, '.'])
    await fs.rm(src, { recursive: true, force: true })
    entry = {
      manifest: { id: EXT_ID, name: 'E2E', version: EXT_VERSION, panels: [{ id: 'm', label: 'M' }], frontend: 'index.html' },
      artifactUrl: pathToFileURL(tgz).toString(),
    }

    mgr = new RuntimeManager()
    const transport = new LocalSubprocessTransport({
      root: workspace,
      id: 'srv_e2e',
      tarballPath,
      installDir,
      env: { ...process.env, CATE_EXTENSIONS_ROOT: hostExtRoot },
    })
    // install=true extracts the tarball before launch; the daemon then runs from
    // its own bundled node over real stdio.
    runtime = await mgr.connect('srv_e2e', transport, { install: true })
  }, 90_000)

  afterAll(async () => {
    await mgr?.disposeAll()
    removeAllowedRoot(workspace)
    for (const dir of [installDir, workspace, hostExtRoot, h.userData]) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
    await fs.rm(path.join(process.cwd(), `cate.e2e-${EXT_VERSION}.tgz`), { force: true }).catch(() => {})
  })

  test('extensionsRoot resolves the daemon env root over the wire', async () => {
    // Proves the new capability marshals over real RPC and the daemon owns the
    // host path (here, the env-injected temp root).
    expect(await runtime.file.extensionsRoot()).toBe(hostExtRoot)
  })

  test('provisions a catalog extension onto the daemon host and serves its asset', async () => {
    const dest = await provisionCatalogToRuntime(runtime, entry)

    // The bytes were extracted host-side under the daemon's extensions root.
    expect(dest).toBe(path.posix.join(hostExtRoot, EXT_ID, EXT_VERSION))
    expect(existsSync(path.join(dest, 'manifest.json'))).toBe(true)
    expect(existsSync(path.join(dest, 'index.html'))).toBe(true)
    expect(existsSync(path.join(dest, '.ok'))).toBe(true)
    // The .tgz the client uploaded was consumed by the host extract.
    expect(existsSync(`${dest}.tgz`)).toBe(false)

    // Serving path: the proxy reads assets via file.readBinary over the wire.
    const asset = await runtime.file.readBinary(path.posix.join(dest, 'index.html'))
    expect(asset.toString()).toContain('e2e-asset')
  }, 30_000)

  test('re-provisioning the same version is idempotent (no re-upload needed)', async () => {
    const first = await provisionCatalogToRuntime(runtime, entry)
    // Remove the client-staged .tgz: a second provision must short-circuit on the
    // host .ok marker (the cheap stat probe), proving it doesn't re-upload.
    await fs.rm(path.join(h.userData, 'extensions', EXT_ID, `${EXT_VERSION}.tgz`), { force: true })
    const second = await provisionCatalogToRuntime(runtime, entry)
    expect(second).toBe(first)
  }, 30_000)

  test('extension storage round-trips through the daemon at <workspace>/.cate', async () => {
    // The runtime-backed store reads/writes <project>/.cate/extensions/<id>/
    // storage.json on the host. Exercise that exact host path over the wire.
    const file = path.posix.join(workspace, '.cate', 'extensions', EXT_ID, 'storage.json')
    await runtime.file.writeFile(file, JSON.stringify({ note: 'persisted-remotely' }))
    const back = JSON.parse(await runtime.file.readFile(file))
    expect(back.note).toBe('persisted-remotely')
  }, 30_000)
})
