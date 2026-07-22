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

describe('normalizeManifest — url mode', () => {
  it('keeps an https url verbatim', () => {
    for (const url of [
      'https://discord.com/app',
      'https://example.com',
      'https://example.com/a/b?c=d#e',
    ]) {
      const m = normalizeManifest(manifest({ url }))
      expect(m?.url).toBe(url)
    }
  })

  it('rejects every non-https scheme', () => {
    for (const url of [
      'http://example.com',
      'http://localhost:3000',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'ws://example.com',
      'chrome://settings',
    ]) {
      const m = normalizeManifest(manifest({ url }))
      // Manifest still loads, but the unsafe url never survives.
      expect(m).not.toBeNull()
      expect(m?.url).toBeUndefined()
    }
  })

  it('drops garbage without throwing', () => {
    for (const url of ['', 'not a url', '://', 42, null, {}, [], true]) {
      const m = normalizeManifest(manifest({ url }))
      expect(m).not.toBeNull()
      expect(m?.url).toBeUndefined()
    }
  })

  it('keeps all declared modes so the resolver can apply precedence', () => {
    const m = normalizeManifest(
      manifest({
        url: 'https://example.com',
        frontend: 'dist/index.html',
        server: { command: 'node server.js' },
      }),
    )
    // server > url > frontend is decided in proxyServer.getProxyUrlFor; the
    // manifest itself is not rejected for declaring several.
    expect(m?.server?.command).toBe('node server.js')
    expect(m?.url).toBe('https://example.com')
    expect(m?.frontend).toBe('dist/index.html')
  })
})

// =============================================================================
// The manifests we actually ship. A url-mode manifest is only useful if its url
// survives normalizeManifest (https-only, parseable) — a typo there degrades
// silently to a blank/frontend panel at runtime, so assert it from disk. url
// extensions must also declare no cateApi: they get no preload and therefore no
// cate.* bridge, so a declared scope would be inert and misleading.
// =============================================================================

const EXTENSIONS_DIR = path.resolve(__dirname, '../../cate-extensions/extensions')

// Every url-mode extension we ship, with the exact entry URL it must point at.
const SHIPPED_URL_EXTENSIONS: Record<string, string> = {
  'cate.confluence': 'https://home.atlassian.com/',
  'cate.discord': 'https://discord.com/app',
  'cate.dynamics365': 'https://www.office.com/apps',
  'cate.hubspot': 'https://app.hubspot.com/',
  'cate.jira': 'https://home.atlassian.com/',
  'cate.pipedrive': 'https://app.pipedrive.com/',
  'cate.salesforce': 'https://login.salesforce.com/',
  'cate.slack': 'https://app.slack.com/client',
  'cate.zohocrm': 'https://crm.zoho.com/crm/ShowHomePage.do',
}

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

  // CI clones the catalog at its default branch, so an extension added in a
  // catalog PR is absent until that PR merges. Skip the ones not on disk rather
  // than fail: the cate-side change has to be mergeable before the catalog one.
  it('round-trip their urls and declare no cateApi', () => {
    for (const [id, url] of Object.entries(SHIPPED_URL_EXTENSIONS)) {
      if (!fs.existsSync(path.join(EXTENSIONS_DIR, id, 'manifest.json'))) continue
      const parsed = readManifest(id)
      expect(parsed.url, id).toBe(url)
      expect(parsed.cateApi, id).toBeUndefined()

      const m = normalizeManifest(parsed)
      expect(m?.url, id).toBe(url)
      expect(m?.cateApi, id).toBeUndefined()
      // url mode only: a server or frontend would win precedence over the url.
      expect(m?.server, id).toBeUndefined()
      expect(m?.frontend, id).toBeUndefined()
    }
  })
})
