// =============================================================================
// distribution.test.ts — end-to-end catalog distribution test against the real
// cate-extensions repo. That repo is its own checkout (gitignored here); its
// build.sh emits dist/catalog/index.json + dist/artifacts/<id>-<ver>.tgz with
// file:// artifact URLs. We point fetchCatalog at that index, then exercise the
// install flow for whatever the catalog actually ships.
//
// Catalog-agnostic on purpose: the user-facing catalog excludes dev/reference
// extensions (manifest.dev: true), so we don't hardcode a specific id. We pick
// a representative server-backed entry and a representative frontend-only entry
// from the built index and assert each installs to a dir holding its declared
// entrypoint. The server entry path is derived from the manifest's
// server.command, so this passes whether the catalog ships JS (server.js) or
// compiled TS (dist/server.js). Skips when the catalog hasn't been built.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'fs'

const h = vi.hoisted(() => ({ userData: '', appPath: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => h.userData, getAppPath: () => h.appPath },
}))

import { fetchCatalog } from './catalog'
import { installFromCatalog, isInstalled } from './download'

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

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'cate-dist-'))
  h.userData = path.join(tmp, 'userData')
  h.appPath = REPO_ROOT
  mkdirSync(h.userData, { recursive: true })
})

afterEach(() => {
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

  it('installFromCatalog extracts a server-backed extension whose declared entry exists', async () => {
    const entries = await fetchCatalog([CATALOG_INDEX])
    const entry = entries.find((e) => e.manifest.server?.command)
    expect(entry, 'catalog should ship a server-backed extension').toBeDefined()

    const root = await installFromCatalog(entry!)

    // manifest.json at the extracted root, and the server entry the manifest's
    // command launches is present (server.js or dist/server.js).
    expect(existsSync(path.join(root, 'manifest.json'))).toBe(true)
    expect(existsSync(path.join(root, serverEntry(entry!.manifest.server!.command)))).toBe(true)
    expect(isInstalled(entry!.manifest.id, entry!.manifest.version ?? '0.0.0')).toBe(true)
  })

  it('installFromCatalog extracts a frontend-only extension whose entry html exists', async () => {
    const entries = await fetchCatalog([CATALOG_INDEX])
    const entry = entries.find((e) => !e.manifest.server && e.manifest.frontend)
    expect(entry, 'catalog should ship a frontend-only extension').toBeDefined()

    const root = await installFromCatalog(entry!)

    // Frontend-only artifact: manifest + the entry html ship in the tarball.
    expect(existsSync(path.join(root, 'manifest.json'))).toBe(true)
    expect(existsSync(path.join(root, entry!.manifest.frontend!))).toBe(true)
    expect(isInstalled(entry!.manifest.id, entry!.manifest.version ?? '0.0.0')).toBe(true)
  })
})
