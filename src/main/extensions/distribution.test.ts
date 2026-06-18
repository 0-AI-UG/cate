// =============================================================================
// distribution.test.ts — end-to-end catalog distribution test against the real
// cate-extensions repo. That repo is its own checkout (gitignored here); its
// build.sh emits dist/catalog/index.json + dist/artifacts/<id>-<ver>.tgz with
// file:// artifact URLs. We point fetchCatalog at that index, assert the
// kitchensink entry parses, then installFromCatalog and assert the artifact
// extracts to a dir whose declared server entry exists.
//
// Language-agnostic on purpose: the entry path is derived from the manifest's
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

describe.skipIf(!HAS_CATALOG)('cate-extensions catalog distribution (kitchensink)', () => {
  it('fetchCatalog parses the kitchensink entry from the built index', async () => {
    const entries = await fetchCatalog([CATALOG_INDEX])
    const ks = entries.find((e) => e.manifest.id === 'cate.kitchensink')
    expect(ks).toBeDefined()
    expect(ks!.manifest.name).toBe('Kitchen Sink (Extension API Demo)')
    expect(ks!.manifest.version).toBe('1.0.0')
    expect(ks!.manifest.server?.readyPath).toBe('/health')
    expect(serverEntry(ks!.manifest.server?.command ?? '')).toMatch(/server\.js$/)
    expect(ks!.manifest.cateApi).toEqual(['storage', 'editor', 'canvas', 'theme'])
    expect(ks!.artifactUrl).toContain('cate.kitchensink-1.0.0.tgz')
    expect(ks!.description).toMatch(/Kitchen Sink/i)
  })

  it('installFromCatalog extracts a valid server-backed extension', async () => {
    const entries = await fetchCatalog([CATALOG_INDEX])
    const ks = entries.find((e) => e.manifest.id === 'cate.kitchensink')!
    const root = await installFromCatalog(ks)

    // manifest.json at the extracted root, and the server entry the manifest's
    // command launches is present (server.js or dist/server.js).
    expect(existsSync(path.join(root, 'manifest.json'))).toBe(true)
    expect(existsSync(path.join(root, serverEntry(ks.manifest.server!.command)))).toBe(true)
    expect(isInstalled('cate.kitchensink', '1.0.0')).toBe(true)
  })
})
