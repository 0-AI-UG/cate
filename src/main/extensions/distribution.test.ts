// =============================================================================
// distribution.test.ts — end-to-end catalog distribution test against the real
// cate-extensions repo. That repo is its own checkout (gitignored here); its
// build.sh emits dist/catalog/index.json + dist/artifacts/<id>-<ver>.tgz with
// file:// artifact URLs. We point fetchCatalog at that index, then exercise the
// full install path for whatever the catalog actually ships: stage the artifact
// on the client (download + verify) and provision it onto a host through the
// runtime (file.extractArtifact), exactly as a real local/remote workspace would.
//
// Catalog-agnostic on purpose: the user-facing catalog excludes dev/reference
// extensions (manifest.dev: true), so we don't hardcode a specific id. We pick a
// representative server-backed entry and a representative frontend-only entry from
// the built index and assert each provisions to a host dir holding its declared
// entrypoint. The server entry path is derived from the manifest's server.command,
// so this passes whether the catalog ships JS (server.js) or compiled TS
// (dist/server.js). Skips when the catalog hasn't been built.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from 'fs'

const h = vi.hoisted(() => ({ userData: '', appPath: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => h.userData, getAppPath: () => h.appPath },
}))

import { fetchCatalog } from './catalog'
import { provisionCatalogToRuntime } from './install'
import { buildDaemonRuntime } from '../../runtime/capabilities'
import { loopbackRuntime } from '../runtime/testHarness'
import { LOCAL_RUNTIME_ID } from '../runtime/locator'
import type { Runtime } from '../runtime/types'

// Repo root = three levels up from src/main/extensions/.
const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../../..')
const EXT_REPO = path.join(REPO_ROOT, 'cate-extensions')
const CATALOG_INDEX = path.join(EXT_REPO, 'dist', 'catalog', 'index.json')

/** The .js entry a server-backed manifest launches, e.g. "node dist/server.js"
 *  -> "dist/server.js". Lets the assertions ignore JS-vs-compiled-TS layout. */
function serverEntry(command: string): string {
  return command.split(/\s+/).find((t) => t.endsWith('.js')) ?? ''
}

let tmp: string
let hostRoot: string
let runtime: Runtime

beforeEach(() => {
  // realpath so the registered allowed root matches validatePathStrict's
  // symlink-resolved comparison (e.g. /var → /private/var on macOS).
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cate-dist-')))
  h.userData = path.join(tmp, 'userData') // client staging cache
  h.appPath = REPO_ROOT
  mkdirSync(h.userData, { recursive: true })
  // Provision onto a real (in-process) daemon runtime; point its extensions root
  // at a temp dir (always allowed, since under os.tmpdir()) so we never touch the
  // real ~/.cate. id LOCAL so host path joins use the native separator.
  hostRoot = path.join(tmp, 'host-extensions')
  process.env.CATE_EXTENSIONS_ROOT = hostRoot
  runtime = loopbackRuntime(buildDaemonRuntime({ id: LOCAL_RUNTIME_ID }).runtime, LOCAL_RUNTIME_ID)
})

afterEach(() => {
  delete process.env.CATE_EXTENSIONS_ROOT
  rmSync(tmp, { recursive: true, force: true })
})

// The catalog must be checked out AND built (run cate-extensions/build.sh).
// Skip otherwise so a checkout without the sibling repo stays green.
const HAS_CATALOG = existsSync(CATALOG_INDEX)

describe.skipIf(!HAS_CATALOG)('cate-extensions catalog distribution', () => {
  it('fetchCatalog parses the built index into well-formed, installable entries', async () => {
    const entries = await fetchCatalog([CATALOG_INDEX])
    // The user-facing catalog excludes dev/reference extensions, but always
    // ships at least one real extension.
    expect(entries.length).toBeGreaterThan(0)
    for (const e of entries) {
      expect(e.manifest.id).toBeTruthy()
      expect(Array.isArray(e.manifest.panels)).toBe(true)
      expect(e.artifactUrl).toContain(`${e.manifest.id}-`)
      expect(e.artifactUrl).toMatch(/\.tgz$/)
    }
  })

  it('provisions a server-backed extension whose declared entry exists on the host', async () => {
    const entries = await fetchCatalog([CATALOG_INDEX])
    const entry = entries.find((e) => e.manifest.server?.command)
    expect(entry, 'catalog should ship a server-backed extension').toBeDefined()

    const root = await provisionCatalogToRuntime(runtime, entry!)

    // manifest.json at the provisioned host root, and the server entry the
    // manifest's command launches is present (server.js or dist/server.js).
    expect(existsSync(path.join(root, 'manifest.json'))).toBe(true)
    expect(existsSync(path.join(root, serverEntry(entry!.manifest.server!.command)))).toBe(true)
    expect(existsSync(path.join(root, '.ok'))).toBe(true)
  })

  it('provisions a frontend-only extension whose entry html exists on the host', async () => {
    const entries = await fetchCatalog([CATALOG_INDEX])
    const entry = entries.find((e) => !e.manifest.server && e.manifest.frontend)
    expect(entry, 'catalog should ship a frontend-only extension').toBeDefined()

    const root = await provisionCatalogToRuntime(runtime, entry!)

    // Frontend-only artifact: manifest + the entry html ship in the tarball.
    expect(existsSync(path.join(root, 'manifest.json'))).toBe(true)
    expect(existsSync(path.join(root, entry!.manifest.frontend!))).toBe(true)
    expect(existsSync(path.join(root, '.ok'))).toBe(true)
  })

  it('is idempotent: re-provisioning the same version reuses the host dir', async () => {
    const entries = await fetchCatalog([CATALOG_INDEX])
    const entry = entries.find((e) => e.manifest.frontend) ?? entries[0]
    const first = await provisionCatalogToRuntime(runtime, entry)
    const second = await provisionCatalogToRuntime(runtime, entry)
    expect(second).toBe(first)
    expect(existsSync(path.join(first, '.ok'))).toBe(true)
  })
})
