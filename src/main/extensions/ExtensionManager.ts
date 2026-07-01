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
import {
  stageArtifact,
  stagedVersions,
  removeStaged,
  removeStagedVersionsExcept,
} from './download'
import { provisionCatalogToRuntime, provisionSideloadToRuntime } from './install'
import { runtimes } from '../runtime/runtimeManager'
import type { Runtime } from '../runtime/types'
import type { RuntimeId } from '../runtime/locator'
import type { ExtensionListEntry, ExtensionManifest } from '../../shared/extensions'

interface KnownExtension {
  manifest: ExtensionManifest
  source: 'catalog' | 'sideload'
  /** Sideload: the local dev folder (also the source uploaded to remote hosts).
   *  Catalog: the client source is the staged .tgz, so this stays '' — the served
   *  bytes live on the workspace's runtime HOST, resolved per-runtime by
   *  ensureProvisioned, not in this host-independent registry. */
  rootDir: string
  /** Catalog: artifact staged (downloaded + verified) on the client. Sideload:
   *  always true (the folder is the source). Gates renderer panel registration. */
  installed: boolean
  /** The staged version (catalog only); undefined when not staged. */
  installedVersion?: string
  description?: string
  /** The catalog entry (for staging/provisioning). Only set on catalog sources. */
  catalogEntry?: CatalogEntry
}

export class ExtensionManager {
  // extensionId -> known extension. Rebuilt from settings on every refresh so
  // the registry can't drift from the authoritative on-disk state.
  private known = new Map<string, KnownExtension>()
  private loaded = false
  private initialized = false

  // runtimeId -> (extensionId -> { host root dir, generation provisioned }). The
  // result of provisioning an extension onto a host: where its bytes live on that
  // runtime, tagged with the bytes-generation that produced them. Populated lazily
  // by ensureProvisioned and eagerly on host connect.
  private provisioned = new Map<RuntimeId, Map<string, { rootDir: string; gen: number }>>()
  // extensionId -> current bytes generation. Bumped whenever an extension's bytes
  // change (reinstall/update/uninstall/disable); a host whose cached provision is
  // an older generation is force re-extracted on next use (so a same-version
  // reinstall actually repairs the host copy, not just the client stage).
  private genByExt = new Map<string, number>()
  // De-dupe concurrent provisions of the same (runtimeId, extensionId) so two
  // panels opening at once upload the artifact only once.
  private provisioning = new Map<string, Promise<string>>()

  /** Subscribe to host-connect events so an enabled extension is provisioned onto
   *  every host as it comes online (eager). Idempotent; call once at startup. */
  init(): void {
    if (this.initialized) return
    this.initialized = true
    runtimes.onConnected((_id, runtime) => {
      void this.provisionAllEnabled(runtime)
    })
    // On a live drop, the host copy of an extension may be gone (an ephemeral
    // host) and the cached rootDir/gen must not be trusted across a reconnect,
    // so invalidate this runtime's provision cache. Then release any extension
    // server sessions stranded on the dead runtime handle so the next panel open
    // rebuilds them fresh against the reconnected runtime. Lazy import avoids a
    // static cycle (ExtensionServerManager imports this module at the top level).
    runtimes.onDisconnected((id) => {
      this.provisioned.delete(id)
      void import('./ExtensionServerManager')
        .then((m) => m.extensionServerManager.disposeForRuntime(id))
        .catch((err) => { log.warn('[extensions] disposeForRuntime %s failed: %O', id, err) })
    })
  }

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
      const latest = entry.manifest.version ?? '0.0.0'
      // Any extracted version counts as installed (a catalog refresh may have
      // bumped `latest` past what's on disk — that surfaces as updateAvailable).
      // Prefer serving `latest` when it's present, else whatever is on disk.
      const versions = await stagedVersions(id)
      const installed = versions.length > 0
      const served = versions.includes(latest) ? latest : versions[versions.length - 1]
      next.set(id, {
        manifest: entry.manifest,
        source: 'catalog',
        // Catalog bytes live on the runtime host (per-workspace); the registry is
        // host-independent, so rootDir stays '' here (resolved via ensureProvisioned).
        rootDir: '',
        installed,
        installedVersion: installed ? served : undefined,
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
    return Array.from(this.known.values()).map((k) => {
      const latest = k.manifest.version
      return {
        manifest: k.manifest,
        enabled: enabled.has(k.manifest.id),
        source: k.source,
        rootDir: k.rootDir,
        installed: k.installed,
        version: latest,
        installedVersion: k.installedVersion,
        // Only catalog extensions carry a separate installed-vs-advertised
        // version; sideload always serves its live folder.
        updateAvailable:
          k.source === 'catalog' &&
          k.installed &&
          !!k.installedVersion &&
          !!latest &&
          k.installedVersion !== latest,
        description: k.description,
      }
    })
  }

  getManifest(extensionId: string): ExtensionManifest | undefined {
    return this.known.get(extensionId)?.manifest
  }

  /**
   * Ensure the extension's bytes are present on `runtime`'s host and return the
   * host-absolute root dir to serve / run the server from. Catalog extensions are
   * staged on the client then uploaded + extracted host-side; sideload folders
   * are served in place (local) or uploaded (remote). Idempotent + de-duped per
   * (runtimeId, extensionId): the result is cached, so repeat calls (every panel
   * open, every asset request) don't re-upload. Throws for an unknown extension.
   */
  async ensureProvisioned(extensionId: string, runtime: Runtime): Promise<string> {
    const known = this.known.get(extensionId)
    if (!known) throw new Error(`Unknown extension: ${extensionId}`)

    const gen = this.genByExt.get(extensionId) ?? 0
    const cached = this.provisioned.get(runtime.id)?.get(extensionId)
    // A cache hit at the current generation is the live host copy; an older
    // generation means the bytes changed since, so force a re-extract.
    if (cached && cached.gen === gen) return cached.rootDir
    const force = cached !== undefined && cached.gen !== gen

    const lockKey = `${runtime.id} ${extensionId}`
    const inflight = this.provisioning.get(lockKey)
    if (inflight) return inflight

    const work = (async () => {
      const rootDir =
        known.source === 'sideload'
          ? await provisionSideloadToRuntime(runtime, extensionId, known.rootDir)
          : await this.provisionCatalog(known, runtime, force)
      let perRuntime = this.provisioned.get(runtime.id)
      if (!perRuntime) {
        perRuntime = new Map()
        this.provisioned.set(runtime.id, perRuntime)
      }
      perRuntime.set(extensionId, { rootDir, gen })
      return rootDir
    })()
    this.provisioning.set(lockKey, work)
    try {
      return await work
    } finally {
      this.provisioning.delete(lockKey)
    }
  }

  private async provisionCatalog(known: KnownExtension, runtime: Runtime, force: boolean): Promise<string> {
    if (!known.catalogEntry) {
      throw new Error(`Extension ${known.manifest.id} has no catalog entry to provision`)
    }
    const dest = await provisionCatalogToRuntime(runtime, known.catalogEntry, force)
    known.installed = true
    known.installedVersion = known.manifest.version ?? '0.0.0'
    return dest
  }

  /** Provision every enabled, known extension onto a freshly-connected host
   *  (eager). Per-extension failures are logged, never thrown — one bad
   *  extension must not block the rest or break the connect. */
  async provisionAllEnabled(runtime: Runtime): Promise<void> {
    await this.refresh()
    const enabled = new Set(getSetting('enabledExtensions'))
    for (const id of this.known.keys()) {
      if (!enabled.has(id)) continue
      try {
        await this.ensureProvisioned(id, runtime)
      } catch (err) {
        log.warn('[extensions] eager provision of %s to %s failed: %O', id, runtime.id, err)
      }
    }
  }

  /** Mark an extension's bytes as changed: bump its generation so every host's
   *  cached provision is re-extracted (force) on next use, and clear any cached
   *  static assets serving the old bytes. Call on reinstall/update/uninstall/
   *  disable. (We keep the per-runtime cache entries so the generation compare in
   *  ensureProvisioned can detect staleness even after a host reconnects.) */
  private invalidateProvisioned(extensionId: string): void {
    this.genByExt.set(extensionId, (this.genByExt.get(extensionId) ?? 0) + 1)
    // Drop cached static assets (keyed by host root dir) for the old bytes. Lazy
    // dynamic import avoids a static import cycle (proxyServer imports this module).
    void import('./proxyServer')
      .then((m) => m.clearStaticAssetCache())
      .catch(() => { /* proxy not started yet; nothing cached */ })
  }

  /** Re-provision an extension onto every currently-connected runtime (fire-and-
   *  forget). Used after enable so an already-open remote workspace gets the
   *  bytes without waiting for the next panel open. */
  private reprovisionConnected(extensionId: string): void {
    for (const runtimeId of runtimes.registeredIds()) {
      let runtime: Runtime
      try {
        runtime = runtimes.resolve(runtimeId)
      } catch {
        continue
      }
      void this.ensureProvisioned(extensionId, runtime).catch((err) => {
        log.warn('[extensions] provision of %s to %s failed: %O', extensionId, runtimeId, err)
      })
    }
  }

  isEnabled(extensionId: string): boolean {
    return getSetting('enabledExtensions').includes(extensionId)
  }

  isKnown(extensionId: string): boolean {
    return this.known.has(extensionId)
  }

  /** Stage a catalog extension's artifact on the client (download + verify)
   *  without enabling it. Marks it installed. With `force`, re-downloads over the
   *  staged copy (reinstall). The host extraction happens later, per-runtime, via
   *  ensureProvisioned. No-op (with a thrown error) for unknown or non-catalog ids. */
  async installCatalogExtension(extensionId: string, force = false): Promise<void> {
    const known = this.known.get(extensionId)
    if (!known) throw new Error(`Unknown extension: ${extensionId}`)
    if (known.source !== 'catalog' || !known.catalogEntry) {
      // Sideload is already installed; nothing to download.
      if (known.installed && !force) return
      throw new Error(`Extension ${extensionId} is not a catalog extension`)
    }
    await stageArtifact(known.catalogEntry, force)
    known.installed = true
    known.installedVersion = known.manifest.version ?? '0.0.0'
    // The staged bytes changed (or are new); drop any host-provisioned copies so
    // the next open re-uploads + re-extracts the current artifact.
    this.invalidateProvisioned(extensionId)
  }

  /** Re-download a catalog extension's current version over the installed copy
   *  (repairs a corrupt/partial install). Leaves enable state untouched. */
  async reinstall(extensionId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.installCatalogExtension(extensionId, true)
      // Stop the running server so the next panel open spawns the fresh bytes
      // (the old process keeps serving stale assets until it's killed).
      await this.stopServer(extensionId)
      await this.refresh(true)
      this.broadcast()
      return { ok: true }
    } catch (err) {
      log.warn('[extensions] reinstall %s failed: %O', extensionId, err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** Install the catalog's latest version and drop the older installed one(s).
   *  Leaves enable state untouched, so an enabled extension stays enabled and
   *  begins serving the new version. */
  async update(extensionId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.installCatalogExtension(extensionId)
      const latest = this.known.get(extensionId)?.manifest.version ?? '0.0.0'
      await removeStagedVersionsExcept(extensionId, latest)
      // Stop the running server so the next panel open spawns the new version
      // instead of continuing to serve the old process's bytes.
      await this.stopServer(extensionId)
      await this.refresh(true)
      this.broadcast()
      return { ok: true }
    } catch (err) {
      log.warn('[extensions] update %s failed: %O', extensionId, err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** Disable and fully remove an installed catalog extension from disk. (Use
   *  removeSideload for sideload folders.) */
  async uninstall(extensionId: string): Promise<void> {
    const known = this.known.get(extensionId)
    const enabled = getSetting('enabledExtensions')
    if (enabled.includes(extensionId)) {
      setSetting('enabledExtensions', enabled.filter((id) => id !== extensionId))
    }
    // Stop the server BEFORE removing files so the running process isn't holding
    // or serving the dir while we delete it.
    await this.stopServer(extensionId)
    if (!known || known.source === 'catalog') {
      await removeStaged(extensionId)
    }
    // Drop cached host roots; the host copies under ~/.cate/extensions are left
    // as harmless orphans (a future re-provision overwrites them).
    this.invalidateProvisioned(extensionId)
    await this.refresh(true)
    this.broadcast()
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
    // Eagerly push to any already-connected host so an open remote workspace can
    // use it without waiting for the next reconnect.
    this.reprovisionConnected(extensionId)
    this.broadcast()
  }

  disable(extensionId: string): void {
    const current = getSetting('enabledExtensions')
    if (!current.includes(extensionId)) return
    setSetting('enabledExtensions', current.filter((id) => id !== extensionId))
    this.invalidateProvisioned(extensionId)
    // Fire-and-forget: stop the now-disabled extension's server so it isn't left
    // running. stopServer already swallows + logs its own errors. Kept sync to
    // preserve disable's void signature (its single caller doesn't await it).
    void this.stopServer(extensionId)
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
      // Stop its server too — the sideload folder's assets are no longer served.
      await this.stopServer(provided.manifest.id)
      this.invalidateProvisioned(provided.manifest.id)
    }
    await this.refresh(true)
    this.broadcast()
  }

  /** Stop any running server child(ren) for this extension. Non-fatal: a stop
   *  failure must never break the user action that triggered it, so we log and
   *  swallow. Uses a lazy dynamic import to avoid a static import cycle with
   *  ExtensionServerManager (which imports this module at the top level). */
  private async stopServer(extensionId: string): Promise<void> {
    try {
      const { extensionServerManager } = await import('./ExtensionServerManager')
      await extensionServerManager.stopForExtension(extensionId)
    } catch (err) {
      log.warn('[extensions] stopping server for %s failed: %O', extensionId, err)
    }
  }

  private broadcast(): void {
    broadcastToAll(EXTENSIONS_CHANGED)
  }
}

export const extensionManager = new ExtensionManager()
