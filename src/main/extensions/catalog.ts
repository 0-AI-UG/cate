// =============================================================================
// Extension catalog — fetch + merge remote/local catalog indexes and cache the
// merged result so the extension list works offline after one refresh.
//
// catalog index JSON:
//   { "extensions": [ { "manifest": {/* ExtensionManifest */},
//                       "artifactUrl": "...", "sha256": "...",
//                       "description": "..." } ] }
//
// A source is either an http(s):// URL (fetched) or a local source — a plain
// absolute path or a file:// URL — read straight off disk so catalogs can be
// tested offline. Sources are merged left-to-right: a later source overrides an
// earlier one on a duplicate extension id. A failing source is logged + skipped,
// never fatal to the whole fetch.
//
// The merged index is cached to userData/extensions/catalog-cache.json (plain
// atomic write) so getCachedCatalog() returns the last good catalog with no
// network. artifactUrl values are stored verbatim so a relative/file:// path in
// a local index resolves the same way on install.
// =============================================================================

import { app } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import log from '../logger'
import { normalizeManifest, type ExtensionManifest } from '../../shared/extensions'

export interface CatalogEntry {
  manifest: ExtensionManifest
  artifactUrl: string
  sha256?: string
  description?: string
}

/** Root for all catalog/extension state under userData. */
export function extensionsDir(): string {
  return path.join(app.getPath('userData'), 'extensions')
}

function cacheFile(): string {
  return path.join(extensionsDir(), 'catalog-cache.json')
}

/** True for a source we read off disk instead of fetching. */
function isLocalSource(source: string): boolean {
  return source.startsWith('file://') || path.isAbsolute(source)
}

/** Resolve a local source string (absolute path or file:// URL) to a fs path. */
function localSourcePath(source: string): string {
  return source.startsWith('file://') ? fileURLToPath(source) : source
}

/** Load one source's raw index text (http(s) via fetch, else off disk). */
async function loadSourceText(source: string): Promise<string> {
  if (isLocalSource(source)) {
    return readFile(localSourcePath(source), 'utf-8')
  }
  const res = await fetch(source)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

/** Validate one untrusted catalog entry into a CatalogEntry, or null. */
function normalizeEntry(parsed: unknown): CatalogEntry | null {
  if (typeof parsed !== 'object' || parsed === null) return null
  const o = parsed as Record<string, unknown>
  const manifest = normalizeManifest(o.manifest)
  if (!manifest) return null
  if (typeof o.artifactUrl !== 'string' || o.artifactUrl.length === 0) return null
  const entry: CatalogEntry = { manifest, artifactUrl: o.artifactUrl }
  if (typeof o.sha256 === 'string' && o.sha256.length > 0) entry.sha256 = o.sha256
  if (typeof o.description === 'string' && o.description.length > 0) entry.description = o.description
  return entry
}

/** Parse one source's index text into validated entries. Throws on bad JSON. */
function parseIndex(text: string, source: string): CatalogEntry[] {
  const parsed = JSON.parse(text) as unknown
  const list =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>).extensions
      : undefined
  if (!Array.isArray(list)) {
    log.warn('[extensions] catalog %s has no "extensions" array', source)
    return []
  }
  const out: CatalogEntry[] = []
  for (const raw of list) {
    const entry = normalizeEntry(raw)
    if (entry) out.push(entry)
    else log.warn('[extensions] catalog %s: skipping invalid entry', source)
  }
  return out
}

/**
 * Fetch + merge all catalog sources. Tolerates a failing source (logs + skips)
 * and never throws. Later sources override earlier ones on duplicate id.
 */
export async function fetchCatalog(sources: string[]): Promise<CatalogEntry[]> {
  const merged = new Map<string, CatalogEntry>()
  for (const source of sources) {
    if (!source) continue
    try {
      const text = await loadSourceText(source)
      for (const entry of parseIndex(text, source)) {
        merged.set(entry.manifest.id, entry)
      }
    } catch (err) {
      log.warn('[extensions] catalog source failed (%s): %O', source, err)
    }
  }
  return Array.from(merged.values())
}

/** Persist the merged catalog so getCachedCatalog() works offline. */
export async function writeCatalogCache(entries: CatalogEntry[]): Promise<void> {
  const dest = cacheFile()
  await mkdir(extensionsDir(), { recursive: true })
  const tmp = `${dest}.${process.pid}.part`
  await writeFile(tmp, JSON.stringify({ extensions: entries }, null, 2))
  await rename(tmp, dest)
}

/**
 * The last cached merged catalog, read synchronously-ish off disk. Returns []
 * when no cache exists yet or it is corrupt.
 */
export async function getCachedCatalog(): Promise<CatalogEntry[]> {
  const file = cacheFile()
  if (!existsSync(file)) return []
  try {
    const text = await readFile(file, 'utf-8')
    return parseIndex(text, file)
  } catch (err) {
    log.warn('[extensions] catalog cache unreadable: %O', err)
    return []
  }
}
