import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  EXTENSION_CATEGORIES,
  extensionCategoryLabel,
  normalizeManifest,
  resolveExtensionCategory,
} from './extensions'

// A minimal valid manifest body, parameterised by id/version, so each test can
// vary only the field under scrutiny.
function manifest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'acme.example',
    name: 'Acme Example',
    panels: [{ id: 'main', label: 'Main' }],
    ...overrides,
  }
}

const SEPARATOR = /[/\\]/

describe('normalizeManifest — id validation', () => {
  it('accepts real dotted ids', () => {
    for (const id of ['acme.example', 'cate.frontendkit', 'cate.hello']) {
      const m = normalizeManifest(manifest({ id }))
      expect(m).not.toBeNull()
      expect(m?.id).toBe(id)
    }
  })

  it('rejects path-traversal ids by returning null', () => {
    for (const id of ['../evil', 'a/../b', '/abs', '..\\win', '..', '.', '']) {
      expect(normalizeManifest(manifest({ id }))).toBeNull()
    }
  })

  it('rejects leading-dot (hidden) ids', () => {
    expect(normalizeManifest(manifest({ id: '.hidden' }))).toBeNull()
  })

  it('rejects ids containing a NUL byte', () => {
    expect(normalizeManifest(manifest({ id: 'a\u0000b' }))).toBeNull()
  })
})

describe('normalizeManifest — category validation', () => {
  it('keeps every known category id', () => {
    for (const { id } of EXTENSION_CATEGORIES) {
      expect(normalizeManifest(manifest({ category: id }))?.category).toBe(id)
    }
  })

  it('drops an unknown or non-string category, filing it under Other', () => {
    for (const category of ['frontend', 'url', '', 42, null, {}]) {
      const m = normalizeManifest(manifest({ category }))
      expect(m).not.toBeNull()
      expect(m?.category).toBeUndefined()
      expect(resolveExtensionCategory(m ?? undefined)).toBe('other')
    }
  })

  it('resolves a missing manifest/category to other', () => {
    expect(resolveExtensionCategory(undefined)).toBe('other')
    expect(resolveExtensionCategory(normalizeManifest(manifest()) ?? undefined)).toBe('other')
  })

  it('labels known ids and falls back to the raw id', () => {
    expect(extensionCategoryLabel('sales')).toBe('Sales & CRM')
    expect(extensionCategoryLabel('nope')).toBe('nope')
  })
})

describe('normalizeManifest — version validation', () => {
  it('preserves a valid semver version (including build metadata)', () => {
    const m = normalizeManifest(manifest({ version: '1.2.3+build.5' }))
    expect(m).not.toBeNull()
    expect(m?.version).toBe('1.2.3+build.5')
  })

  it('drops an unsafe version but keeps the manifest usable', () => {
    for (const version of ['../x', 'a/../b', '/abs', '..\\win', '..']) {
      const m = normalizeManifest(manifest({ version }))
      // Manifest still returned (unsafe version degrades to unversioned)...
      expect(m).not.toBeNull()
      // ...but the unsafe string never survives, and no separator can reach a path.
      expect(m?.version).not.toBe(version)
      if (m?.version) expect(SEPARATOR.test(m.version)).toBe(false)
      expect(m?.version).toBeUndefined()
    }
  })
})

// =============================================================================
// The manifests we actually ship must all be valid JSON that normalizes to a
// usable manifest — a typo there degrades silently at runtime, so assert it
// from disk.
// =============================================================================

const EXTENSIONS_DIR = path.resolve(__dirname, '../../cate-extensions/extensions')

function readManifest(id: string): Record<string, unknown> {
  const raw = fs.readFileSync(path.join(EXTENSIONS_DIR, id, 'manifest.json'), 'utf8')
  return JSON.parse(raw) as Record<string, unknown>
}

// cate-extensions/ is a SEPARATE repo, gitignored here and only present in a dev
// tree that checked it out alongside. Skip rather than ENOENT when it is absent
// (e.g. a CI job that clones cate on its own).
describe.skipIf(!fs.existsSync(EXTENSIONS_DIR))('shipped manifests on disk', () => {
  it('are all valid JSON that normalizes to a usable manifest', () => {
    const ids = fs
      .readdirSync(EXTENSIONS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) {
      const parsed = readManifest(id)
      const m = normalizeManifest(parsed)
      expect(m, `${id}/manifest.json failed to normalize`).not.toBeNull()
      expect(m?.id).toBe(id)
      expect(m?.panels.length).toBeGreaterThan(0)
      // A declared category must be one we know — a typo would silently demote
      // the extension to "Other" in the catalog UI. Absence is fine: the
      // catalog repo is a separate PR that lands after this one.
      if (parsed.category !== undefined) {
        expect(m?.category, `${id}/manifest.json has an unknown category`).toBe(parsed.category)
      }
    }
  })
})
