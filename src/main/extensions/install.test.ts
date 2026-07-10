// =============================================================================
// install.ts — provisioning an extension onto a host THROUGH the runtime, for
// both a LOCAL and a (simulated) REMOTE workspace. The whole point of the unified
// path is that there is no isLocal branch: a catalog extension is staged on the
// client, then uploaded + extracted on whichever host owns the workspace via
// runtime.file.*. Here we drive a real in-process daemon runtime under BOTH a
// 'local' id and a 'srv_test' (remote) id and assert the bytes land host-side.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import os from 'os'
import path from 'path'
import { pathToFileURL } from 'url'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'fs'

const h = vi.hoisted(() => ({ userData: '', appPath: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => h.userData, getAppPath: () => h.appPath },
}))

import { provisionCatalogToRuntime, provisionSideloadToRuntime } from './install'
import { hostJoin } from '../../agent/main/agentDir'
import { buildDaemonRuntime } from '../../runtime/capabilities'
import { loopbackRuntime } from '../runtime/testHarness'
import type { CatalogEntry } from './catalog'
import type { Runtime } from '../runtime/types'

let tmp: string
let hostRoot: string

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cate-install-')))
  h.userData = path.join(tmp, 'userData')
  h.appPath = tmp
  mkdirSync(h.userData, { recursive: true })
  hostRoot = path.join(tmp, 'host-extensions')
  process.env.CATE_EXTENSIONS_ROOT = hostRoot
})

afterEach(() => {
  delete process.env.CATE_EXTENSIONS_ROOT
  rmSync(tmp, { recursive: true, force: true })
})

function buildEntry(id = 'cate.hello', version = '1.2.0'): CatalogEntry {
  const srcDir = path.join(tmp, `src-${id}-${version}`)
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(
    path.join(srcDir, 'manifest.json'),
    JSON.stringify({ id, name: 'Hello', version, panels: [{ id: 'main', label: 'Hello' }], frontend: 'index.html' }),
  )
  writeFileSync(path.join(srcDir, 'index.html'), '<!doctype html><h1>hi</h1>')
  const file = path.join(tmp, `${id}-${version}.tgz`)
  execFileSync('tar', ['-czf', file, '-C', srcDir, '.'])
  return {
    manifest: { id, name: 'Hello', version, panels: [{ id: 'main', label: 'Hello' }], frontend: 'index.html' },
    artifactUrl: pathToFileURL(file).toString(),
    sourceIsLocal: true,
  }
}

// A daemon runtime under an arbitrary id, so we can pretend it's a remote host.
// In-process loopback (the production RemoteRuntime client over the real
// framing), so the "upload" (writeBinary) and extract run against real fs under
// the temp host root — the same code paths a real remote daemon would run.
function runtimeWithId(id: string): Runtime {
  return loopbackRuntime(buildDaemonRuntime({ id }).runtime, id)
}

describe('provisionCatalogToRuntime', () => {
  it.each([
    ['local', 'local'],
    ['remote', 'srv_test'],
  ])('provisions a catalog extension onto a %s host and extracts it there', async (_label, runtimeId) => {
    const entry = buildEntry()
    const runtime = runtimeWithId(runtimeId)

    const dest = await provisionCatalogToRuntime(runtime, entry)

    // The host dir lives under the (per-host) extensions root, keyed by id+version.
    // Joined with hostJoin's flavor: native for local, POSIX for a remote host —
    // on a Windows client the remote dest therefore has forward-slash tails.
    expect(dest).toBe(hostJoin(runtimeId, hostRoot, 'cate.hello', '1.2.0'))
    expect(existsSync(path.join(dest, 'manifest.json'))).toBe(true)
    expect(existsSync(path.join(dest, 'index.html'))).toBe(true)
    expect(existsSync(path.join(dest, '.ok'))).toBe(true)
    // The assets are readable back through the runtime (the path the proxy takes).
    expect((await runtime.file.readBinary(path.join(dest, 'index.html'))).toString()).toContain('hi')
  })

  it('is idempotent: a second provision does not re-upload (staged tgz can vanish)', async () => {
    const entry = buildEntry()
    const runtime = runtimeWithId('srv_test')
    const first = await provisionCatalogToRuntime(runtime, entry)

    // Delete the client-staged tgz; a re-provision must short-circuit on the host
    // .ok marker WITHOUT needing the staged bytes again.
    rmSync(path.join(h.userData, 'extensions', 'cate.hello', '1.2.0.tgz'))
    const second = await provisionCatalogToRuntime(runtime, entry)
    expect(second).toBe(first)
  })

  it('force re-extracts even when already installed', async () => {
    const entry = buildEntry()
    const runtime = runtimeWithId('local')
    const dest = await provisionCatalogToRuntime(runtime, entry)
    // Tamper with the installed copy, then force a re-provision to restore it.
    writeFileSync(path.join(dest, 'index.html'), 'TAMPERED')
    await provisionCatalogToRuntime(runtime, entry, true)
    expect(readFileSync(path.join(dest, 'index.html'), 'utf8')).toContain('hi')
  })

  it('local (dev) entries re-provision on every call, so source edits land without a version bump', async () => {
    const entry: CatalogEntry = { ...buildEntry(), sourceIsLocal: true }
    const runtime = runtimeWithId('local')
    const dest = await provisionCatalogToRuntime(runtime, entry)
    // Simulate a dev edit landing in the installed copy being stale, then
    // re-provision without `force`: sourceIsLocal alone must re-extract.
    writeFileSync(path.join(dest, 'index.html'), 'STALE')
    await provisionCatalogToRuntime(runtime, entry)
    expect(readFileSync(path.join(dest, 'index.html'), 'utf8')).toContain('hi')
  })
})

describe('provisionSideloadToRuntime', () => {
  it('registers a local dev folder as an allowed root so its assets are readable', async () => {
    // A sideload dev folder OUTSIDE the daemon's default roots (only hostRoot was
    // added). Before the fix, serveStatic's readBinary → validatePathStrict would
    // reject it and every asset 404s; registering it as an allowed root fixes that.
    const folder = path.join(tmp, 'dev-ext')
    mkdirSync(folder, { recursive: true })
    writeFileSync(path.join(folder, 'index.html'), '<!doctype html><h1>hi</h1>')
    const runtime = runtimeWithId('local')

    const dest = await provisionSideloadToRuntime(runtime, 'cate.dev', folder)
    try {
      expect(dest).toBe(folder)
      // The folder's assets are now readable back through the runtime.
      expect((await runtime.file.readBinary(path.join(folder, 'index.html'))).toString()).toContain('hi')
    } finally {
    }
  })
})
