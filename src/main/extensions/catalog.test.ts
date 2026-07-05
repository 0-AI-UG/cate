import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import os from 'os'
import path from 'path'
import { pathToFileURL } from 'url'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'

// electron.app.getPath('userData') -> a per-test temp dir.
const h = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => h.userData } }))

import {
  fetchCatalog,
  getCachedCatalog,
  writeCatalogCache,
  readCappedBytes,
  MAX_CATALOG_INDEX_BYTES,
} from './catalog'

function validEntry(id: string, extra: Record<string, unknown> = {}) {
  return {
    manifest: { id, name: id, version: '1.0.0', panels: [{ id: 'main', label: 'Main' }] },
    artifactUrl: `./${id}.tgz`,
    ...extra,
  }
}

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'cate-catalog-'))
  h.userData = tmp
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** Write an index JSON into the temp dir and return a file:// source URL. */
function writeIndex(name: string, body: unknown): string {
  const file = path.join(tmp, name)
  writeFileSync(file, JSON.stringify(body))
  return pathToFileURL(file).toString()
}

describe('fetchCatalog', () => {
  it('parses a single local file:// source', async () => {
    const src = writeIndex('a.json', { extensions: [validEntry('acme.a')] })
    const entries = await fetchCatalog([src])
    expect(entries).toHaveLength(1)
    expect(entries[0].manifest.id).toBe('acme.a')
    expect(entries[0].artifactUrl).toBe('./acme.a.tgz')
  })

  it('accepts a plain absolute path source', async () => {
    writeIndex('b.json', { extensions: [validEntry('acme.b')] })
    const entries = await fetchCatalog([path.join(tmp, 'b.json')])
    expect(entries.map((e) => e.manifest.id)).toEqual(['acme.b'])
  })

  it('merges sources, later overrides earlier on duplicate id', async () => {
    const s1 = writeIndex('1.json', {
      extensions: [validEntry('dup', { description: 'first' }), validEntry('only1')],
    })
    const s2 = writeIndex('2.json', {
      extensions: [validEntry('dup', { description: 'second' }), validEntry('only2')],
    })
    const entries = await fetchCatalog([s1, s2])
    const byId = Object.fromEntries(entries.map((e) => [e.manifest.id, e]))
    expect(Object.keys(byId).sort()).toEqual(['dup', 'only1', 'only2'])
    expect(byId.dup.description).toBe('second')
  })

  it('preserves source order in the merged result (concurrent fetch)', async () => {
    // Sources are now fetched concurrently, but the merge must still reflect the
    // original source order regardless of which fetch settles first.
    const s1 = writeIndex('order1.json', { extensions: [validEntry('acme.a'), validEntry('acme.b')] })
    const s2 = writeIndex('order2.json', { extensions: [validEntry('acme.c')] })
    const s3 = writeIndex('order3.json', { extensions: [validEntry('acme.d')] })
    const entries = await fetchCatalog([s1, s2, s3])
    expect(entries.map((e) => e.manifest.id)).toEqual(['acme.a', 'acme.b', 'acme.c', 'acme.d'])
  })

  it('tolerates a failing source and keeps the good ones', async () => {
    const good = writeIndex('good.json', { extensions: [validEntry('acme.good')] })
    const missing = pathToFileURL(path.join(tmp, 'does-not-exist.json')).toString()
    const entries = await fetchCatalog([missing, good])
    expect(entries.map((e) => e.manifest.id)).toEqual(['acme.good'])
  })

  it('skips invalid entries but keeps valid siblings', async () => {
    const src = writeIndex('mixed.json', {
      extensions: [
        { manifest: { id: 'no-panels', name: 'x', panels: [] }, artifactUrl: './x.tgz' }, // invalid manifest
        { manifest: { id: 'ok', name: 'ok', panels: [{ id: 'm', label: 'M' }] } }, // missing artifactUrl
        validEntry('acme.ok'),
      ],
    })
    const entries = await fetchCatalog([src])
    expect(entries.map((e) => e.manifest.id)).toEqual(['acme.ok'])
  })

  it('returns [] for a malformed-JSON source rather than throwing', async () => {
    const file = path.join(tmp, 'bad.json')
    writeFileSync(file, '{ not json')
    const entries = await fetchCatalog([pathToFileURL(file).toString()])
    expect(entries).toEqual([])
  })

  it('marks entries from a local source as sourceIsLocal, ignoring the JSON', async () => {
    // Even if the index tries to claim otherwise, locality is derived from the
    // source, not trusted from the entry JSON.
    const src = writeIndex('local.json', {
      extensions: [validEntry('acme.local', { sourceIsLocal: false })],
    })
    const entries = await fetchCatalog([src])
    expect(entries[0].sourceIsLocal).toBe(true)
  })
})

describe('readCappedBytes', () => {
  it('returns the body bytes when under the cap', async () => {
    const res = new Response(new Uint8Array([9, 8, 7]))
    const buf = await readCappedBytes(res, 100, 'test')
    expect(Buffer.from([9, 8, 7]).equals(buf)).toBe(true)
  })

  it('throws once the body exceeds the cap', async () => {
    const res = new Response(new Uint8Array(1000))
    await expect(readCappedBytes(res, 100, 'test')).rejects.toThrow(/exceeds max size/)
  })

  it('exposes a defensible index cap', () => {
    expect(MAX_CATALOG_INDEX_BYTES).toBeGreaterThan(0)
  })
})

describe('catalog cache', () => {
  it('round-trips through writeCatalogCache / getCachedCatalog', async () => {
    expect(await getCachedCatalog()).toEqual([])
    const src = writeIndex('c.json', {
      extensions: [validEntry('acme.c', { description: 'cached' })],
    })
    const entries = await fetchCatalog([src])
    await writeCatalogCache(entries)
    const cached = await getCachedCatalog()
    expect(cached.map((e) => e.manifest.id)).toEqual(['acme.c'])
    expect(cached[0].description).toBe('cached')
    // The trusted, stored locality survives the round-trip (local source here).
    expect(cached[0].sourceIsLocal).toBe(true)
  })
})
