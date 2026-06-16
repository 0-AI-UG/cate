// =============================================================================
// distribution.itest.ts — end-to-end catalog distribution test against the real
// cate-extensions repo layout. Points fetchCatalog at the repo's local
// catalog/index.json, asserts the kitchensink entry parses, then runs
// installFromCatalog on it and asserts the artifact extracts to a dir with a
// valid manifest.json + compiled dist/ output.
//
// Reuses the electron `app` mock pattern from download.test.ts: getAppPath()
// returns the cate repo root so the index's repo-root-relative artifactUrl
// resolves, and getPath('userData') is a throwaway temp dir.
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
const CATALOG_INDEX = path.join(REPO_ROOT, 'cate-extensions', 'catalog', 'index.json')
const ARTIFACT = path.join(
  REPO_ROOT,
  'cate-extensions',
  'catalog',
  'artifacts',
  'cate.kitchensink-1.0.0.tgz',
)

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'cate-dist-'))
  h.userData = path.join(tmp, 'userData')
  // getAppPath() must be the repo root so the repo-root-relative artifactUrl
  // ("cate-extensions/catalog/artifacts/...") resolves against it.
  h.appPath = REPO_ROOT
  mkdirSync(h.userData, { recursive: true })
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

// cate-extensions is its own repo, present here only as a local checkout (it's
// gitignored, never committed). Skip when that checkout is absent.
const HAS_EXT = existsSync(path.join(REPO_ROOT, 'cate-extensions'))

describe.skipIf(!HAS_EXT)('cate-extensions catalog distribution (kitchensink)', () => {
  it('has a built artifact (run cate-extensions/build.sh)', () => {
    expect(existsSync(CATALOG_INDEX)).toBe(true)
    expect(existsSync(ARTIFACT)).toBe(true)
  })

  it('fetchCatalog parses the kitchensink entry from the local index', async () => {
    const entries = await fetchCatalog([CATALOG_INDEX])
    const ks = entries.find((e) => e.manifest.id === 'cate.kitchensink')
    expect(ks).toBeDefined()
    expect(ks!.manifest.name).toBe('Kitchen Sink (Extension API Demo)')
    expect(ks!.manifest.version).toBe('1.0.0')
    expect(ks!.manifest.server?.command).toBe('node dist/server.js')
    expect(ks!.manifest.server?.readyPath).toBe('/health')
    expect(ks!.manifest.cateApi).toEqual(['storage', 'editor', 'canvas', 'theme'])
    expect(ks!.artifactUrl).toContain('cate.kitchensink-1.0.0.tgz')
    expect(ks!.description).toMatch(/CATE_API/)
  })

  it('installFromCatalog extracts a valid server-backed extension', async () => {
    const entries = await fetchCatalog([CATALOG_INDEX])
    const ks = entries.find((e) => e.manifest.id === 'cate.kitchensink')!
    const root = await installFromCatalog(ks)

    // manifest.json at the extracted root + the compiled dist/ output the
    // manifest's `node dist/server.js` command and the panel HTML reference.
    expect(existsSync(path.join(root, 'manifest.json'))).toBe(true)
    expect(existsSync(path.join(root, 'dist', 'server.js'))).toBe(true)
    expect(existsSync(path.join(root, 'dist', 'public', 'index.html'))).toBe(true)
    expect(existsSync(path.join(root, 'dist', 'public', 'app.js'))).toBe(true)
    expect(isInstalled('cate.kitchensink', '1.0.0')).toBe(true)
  })
})
