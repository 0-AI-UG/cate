// =============================================================================
// ExtensionManager — singleton registry of known extensions.
//
// Sources:
//   - sideload: local dev folders, tracked in the `extensionSideloadPaths`
//     setting. Always installed (the folder IS the root dir).
//   - catalog: entries fetched from `extensionCatalogSources`, merged + cached
//     by catalog.ts. A catalog extension is "known" once it appears in the
//     cached index; it only becomes servable (rootDir set) after its artifact
//     is downloaded + extracted by download.ts.
//
// Precedence: a sideloaded extension wins over a catalog extension with the same
// id (local dev work overrides the published artifact).
//
// Enable state lives in the `enabledExtensions` setting (an array of extension
// ids). Catalog source URLs live in `extensionCatalogSources`. Mutations go
// through settingsFile and then broadcast EXTENSIONS_CHANGED to every window so
// all UIs re-fetch the list.
// =============================================================================

import log from '../logger'
import { EXTENSIONS_CHANGED } from '../../shared/ipc-channels'
import { broadcastToAll } from '../windowRegistry'
import { getSetting, setSetting } from '../settingsFile'
import { loadManifestFromDir } from './manifest'
import {
  fetchCatalog,
  getCachedCatalog,
  writeCatalogCache,
  type CatalogEntry,
} from './catalog'
import { installFromCatalog, installedDir, isInstalled } from './download'
import type { ExtensionListEntry, ExtensionManifest } from '../../shared/extensions'

interface KnownExtension {
  manifest: ExtensionManifest
  source: 'catalog' | 'sideload'
  /** Served folder. '' for a catalog entry that isn't installed yet. */
  rootDir: string
  installed: boolean
  description?: string
  /** The catalog entry (for installs). Only set on catalog sources. */
  catalogEntry?: CatalogEntry
}

class ExtensionManager {
  // extensionId -> known extension. Rebuilt from settings on every refresh so
  // the registry can't drift from the authoritative on-disk state.
  private known = new Map<string, KnownExtension>()
  private loaded = false

  /** Load (or reload) the registry from the current settings + cached catalog.
   *  Idempotent on the first call; pass `force` to re-scan after a change. */
  async refresh(force = false): Promise<void> {
    if (this.loaded && !force) return
    this.loaded = true
    const next = new Map<string, KnownExtension>()

    // --- Catalog (from the cached merged index) -----------------------------
    // Registered first so a same-id sideload folder below can override it.
    const cached = await getCachedCatalog()
    for (const entry of cached) {
      const id = entry.manifest.id
      const version = entry.manifest.version ?? '0.0.0'
      const installed = isInstalled(id, version)
      next.set(id, {
        manifest: entry.manifest,
        source: 'catalog',
        rootDir: installed ? installedDir(id, version) : '',
        installed,
        description: entry.description,
        catalogEntry: entry,
      })
    }

    // --- Sideload folders (override catalog on id collision) ----------------
    const folders = getSetting('extensionSideloadPaths')
    for (const dir of folders) {
      const manifest = await loadManifestFromDir(dir)
      if (!manifest) {
        log.warn('[extensions] sideload folder has no usable manifest: %s', dir)
        continue
      }
      // Last-registered wins on id collision; sideload always trumps catalog.
      next.set(manifest.id, { manifest, source: 'sideload', rootDir: dir, installed: true })
    }

    this.known = next
  }

  /** All known extensions plus their enabled/installed flags. */
  list(): ExtensionListEntry[] {
    const enabled = new Set(getSetting('enabledExtensions'))
    return Array.from(this.known.values()).map((k) => ({
      manifest: k.manifest,
      enabled: enabled.has(k.manifest.id),
      source: k.source,
      rootDir: k.rootDir,
      installed: k.installed,
      version: k.manifest.version,
      description: k.description,
    }))
  }

  getManifest(extensionId: string): ExtensionManifest | undefined {
    return this.known.get(extensionId)?.manifest
  }

  /** The folder whose assets the proxy serves for this extension. Empty/undefined
   *  for a catalog extension that hasn't been installed yet. */
  getExtensionRootDir(extensionId: string): string | undefined {
    return this.known.get(extensionId)?.rootDir || undefined
  }

  isEnabled(extensionId: string): boolean {
    return getSetting('enabledExtensions').includes(extensionId)
  }

  isKnown(extensionId: string): boolean {
    return this.known.has(extensionId)
  }

  /** Download + extract a catalog extension without enabling it. Marks it
   *  installed and updates rootDir in the in-memory registry. No-op (with a
   *  thrown error) for unknown or non-catalog ids. */
  async installCatalogExtension(extensionId: string): Promise<void> {
    const known = this.known.get(extensionId)
    if (!known) throw new Error(`Unknown extension: ${extensionId}`)
    if (known.source !== 'catalog' || !known.catalogEntry) {
      // Sideload is already installed; nothing to download.
      if (known.installed) return
      throw new Error(`Extension ${extensionId} is not a catalog extension`)
    }
    const rootDir = await installFromCatalog(known.catalogEntry)
    known.rootDir = rootDir
    known.installed = true
  }

  async enable(extensionId: string): Promise<void> {
    const known = this.known.get(extensionId)
    if (!known) throw new Error(`Unknown extension: ${extensionId}`)
    // A catalog extension must be installed before its assets can be served.
    if (known.source === 'catalog' && !known.installed) {
      await this.installCatalogExtension(extensionId)
    }
    const current = getSetting('enabledExtensions')
    if (current.includes(extensionId)) return
    setSetting('enabledExtensions', [...current, extensionId])
    this.broadcast()
  }

  disable(extensionId: string): void {
    const current = getSetting('enabledExtensions')
    if (!current.includes(extensionId)) return
    setSetting('enabledExtensions', current.filter((id) => id !== extensionId))
    this.broadcast()
  }

  // --- Catalog management ----------------------------------------------------

  /** Re-fetch every catalog source, cache the merged index, re-scan, broadcast. */
  async refreshCatalog(): Promise<{ ok: boolean; error?: string }> {
    try {
      const sources = getSetting('extensionCatalogSources')
      const entries = await fetchCatalog(sources)
      await writeCatalogCache(entries)
      await this.refresh(true)
      this.broadcast()
      return { ok: true }
    } catch (err) {
      log.warn('[extensions] catalog refresh failed: %O', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  getCatalogSources(): string[] {
    return getSetting('extensionCatalogSources')
  }

  async addCatalogSource(url: string): Promise<{ ok: boolean; error?: string }> {
    if (!url) return { ok: false, error: 'Empty catalog source URL' }
    const current = getSetting('extensionCatalogSources')
    if (!current.includes(url)) {
      setSetting('extensionCatalogSources', [...current, url])
    }
    return this.refreshCatalog()
  }

  async removeCatalogSource(url: string): Promise<void> {
    const current = getSetting('extensionCatalogSources')
    if (current.includes(url)) {
      setSetting('extensionCatalogSources', current.filter((u) => u !== url))
    }
    await this.refreshCatalog()
  }

  /** Register a local dev folder: validate its manifest, append the folder to
   *  the `extensionSideloadPaths` setting, and re-scan. */
  async addSideload(
    folder: string,
  ): Promise<{ ok: boolean; error?: string; manifest?: ExtensionManifest }> {
    const manifest = await loadManifestFromDir(folder)
    if (!manifest) {
      return { ok: false, error: 'No valid manifest.json found in that folder.' }
    }
    const current = getSetting('extensionSideloadPaths')
    if (!current.includes(folder)) {
      setSetting('extensionSideloadPaths', [...current, folder])
    }
    await this.refresh(true)
    this.broadcast()
    return { ok: true, manifest }
  }

  /** Drop a sideload folder. Also disables the extension it provided (if any),
   *  since its assets are no longer served. */
  async removeSideload(folder: string): Promise<void> {
    const provided = Array.from(this.known.values()).find(
      (k) => k.source === 'sideload' && k.rootDir === folder,
    )
    const current = getSetting('extensionSideloadPaths')
    if (current.includes(folder)) {
      setSetting('extensionSideloadPaths', current.filter((p) => p !== folder))
    }
    if (provided) {
      const enabled = getSetting('enabledExtensions')
      if (enabled.includes(provided.manifest.id)) {
        setSetting('enabledExtensions', enabled.filter((id) => id !== provided.manifest.id))
      }
    }
    await this.refresh(true)
    this.broadcast()
  }

  private broadcast(): void {
    broadcastToAll(EXTENSIONS_CHANGED)
  }
}

export const extensionManager = new ExtensionManager()
