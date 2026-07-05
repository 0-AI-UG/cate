// =============================================================================
// Extension artifact staging (client side) — download + verify a catalog entry's
// .tgz and cache it, WITHOUT extracting. Extraction now happens on whichever host
// owns the workspace (local OR remote), through the runtime daemon's
// file.extractArtifact capability (see install.ts + runtime/capabilities/
// extensions.ts). The client only fetches, pins (sha256), and caches the bytes so
// any host can be provisioned from the same staged artifact — one install path.
//
// Layout under userData:
//   extensions/<id>/<version>.tgz       staged (verified) artifact
//
// fetch() -> Buffer -> write a *.part temp -> rename; sha256 via crypto. The
// rename makes a present .tgz mean "fully downloaded", so isStaged() is a simple
// existence check.
// =============================================================================

import { app } from 'electron'
import { createHash } from 'crypto'
import path from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'
import { readdir, readFile, rm } from 'fs/promises'
import log from '../logger'
import { compareSemver } from '../semver'
import { writeTextAtomic } from '../writeJsonAtomic'
import { extensionsDir, readCappedBytes, type CatalogEntry } from './catalog'

/** Remote artifact fetch is capped in time and size so a hostile/broken server
 *  can't hang us or stream unbounded bytes into memory. */
export const ARTIFACT_FETCH_TIMEOUT_MS = 120_000
export const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024 // 256 MB

/** Staged artifact path for one (id, version). */
export function stagedTgzPath(id: string, version: string): string {
  return path.join(extensionsDir(), id, `${version}.tgz`)
}

/** True once an (id, version) artifact is fully staged on the client. */
export function isStaged(id: string, version: string): boolean {
  return existsSync(stagedTgzPath(id, version))
}

/** Every staged version of an extension currently cached on the client. */
export async function stagedVersions(id: string): Promise<string[]> {
  const dir = path.join(extensionsDir(), id)
  if (!existsSync(dir)) return []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.tgz'))
    .map((e) => e.name.slice(0, -'.tgz'.length))
    // Semver-sort ascending (raw readdir order is arbitrary/lexical, so '0.9.0'
    // could otherwise sort AFTER '0.10.0'); callers pick the newest as [-1].
    .sort(compareSemver)
}

/** Remove every staged version of an extension (its whole id folder). */
export async function removeStaged(id: string): Promise<void> {
  await rm(path.join(extensionsDir(), id), { recursive: true, force: true })
}

/** Remove every staged version of an extension except `keep`. */
export async function removeStagedVersionsExcept(id: string, keep: string): Promise<void> {
  for (const version of await stagedVersions(id)) {
    if (version === keep) continue
    await rm(stagedTgzPath(id, version), { force: true }).catch(() => {})
  }
}

/** Fall back to '0.0.0' so an unversioned manifest still stages somewhere. */
export function entryVersion(entry: CatalogEntry): string {
  return entry.manifest.version && entry.manifest.version.length > 0
    ? entry.manifest.version
    : '0.0.0'
}

function isLocal(url: string): boolean {
  if (url.startsWith('file://')) return true
  // Any string without an http(s) scheme is a local fs path — absolute, or
  // relative (with or without a leading `./`, e.g. a repo-root-relative catalog
  // artifactUrl), resolved against app.getAppPath() in localArtifactPath.
  return !/^https?:\/\//i.test(url)
}

/** Resolve a local artifact url (file://, absolute, or relative) to a fs path. */
function localArtifactPath(url: string): string {
  if (url.startsWith('file://')) return fileURLToPath(url)
  if (path.isAbsolute(url)) return url
  // Relative paths resolve against the app dir (where examples/ lives in dev).
  return path.resolve(app.getAppPath(), url)
}

/** Fetch the artifact bytes (http(s) via fetch, local via fs read). Remote
 *  reads are time- and size-capped; a local fs read is exempt from the timeout. */
async function readArtifact(url: string): Promise<Buffer> {
  if (isLocal(url)) {
    return readFile(localArtifactPath(url))
  }
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(ARTIFACT_FETCH_TIMEOUT_MS) })
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(`artifact download timed out after ${ARTIFACT_FETCH_TIMEOUT_MS}ms (${url})`)
    }
    throw err
  }
  if (!res.ok) throw new Error(`artifact download failed: HTTP ${res.status} (${url})`)
  return readCappedBytes(res, MAX_ARTIFACT_BYTES, `artifact (${url})`)
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * Ensure a catalog entry's artifact is staged (downloaded + verified) on the
 * client, returning its (id, version, tgzPath). Idempotent: an existing .tgz
 * short-circuits unless `force`.
 *
 * TRUST: the "local dev artifact is exempt from sha256" allowance applies ONLY
 * when the catalog SOURCE the entry came from is itself local (file:// or an
 * absolute path — `entry.sourceIsLocal === true`). An entry from a REMOTE
 * catalog must point at an http(s) artifact AND carry a sha256; a non-http
 * artifactUrl on a remote-sourced entry is rejected (it would otherwise be an
 * arbitrary local-file read driven by remote catalog data). Every real entry is
 * flagged by catalog.normalizeEntry; only directly-constructed dev/test entries
 * lack the flag and fall back to the legacy artifactUrl-scheme check. The
 * safe-tarball check and manifest validation run host-side at extraction time.
 */
export async function stageArtifact(
  entry: CatalogEntry,
  force = false,
): Promise<{ id: string; version: string; tgzPath: string }> {
  const id = entry.manifest.id
  const version = entryVersion(entry)
  const tgz = stagedTgzPath(id, version)

  if (!force && isStaged(id, version)) return { id, version, tgzPath: tgz }

  const artifactIsHttp = /^https?:\/\//i.test(entry.artifactUrl)
  // Trust class: an explicit sourceIsLocal (set by catalog.normalizeEntry for
  // every real entry) is authoritative. When it is absent — only directly
  // constructed dev/test entries — fall back to the legacy artifactUrl-scheme
  // check so those keep working. A production remote-catalog entry is always
  // flagged false, so the strict gate below always applies to it.
  const treatAsLocal =
    entry.sourceIsLocal === undefined ? isLocal(entry.artifactUrl) : entry.sourceIsLocal
  if (!treatAsLocal) {
    // Remote-sourced entry: only http(s) + sha256-pinned artifacts are trusted.
    // A non-http artifactUrl here would be an arbitrary local-file read driven
    // by remote catalog data — reject it.
    if (!artifactIsHttp) {
      throw new Error(
        `artifact for ${id}@${version} came from a remote catalog and must use an http(s) artifactUrl (got "${entry.artifactUrl}")`,
      )
    }
    if (!entry.sha256) {
      throw new Error(`remote artifact for ${id}@${version} is missing a required sha256`)
    }
  } else if (artifactIsHttp && !entry.sha256) {
    // Even a locally-sourced entry can't fetch un-pinned bytes off the network.
    throw new Error(`remote artifact for ${id}@${version} is missing a required sha256`)
  }
  const buf = await readArtifact(entry.artifactUrl)
  if (entry.sha256 && sha256(buf) !== entry.sha256.toLowerCase()) {
    throw new Error(`sha256 mismatch for ${id}@${version}`)
  }
  // Atomic write (unique tmp + rename, parent dir created) via the shared
  // primitive, so a present .tgz always means "fully downloaded".
  await writeTextAtomic(tgz, buf)
  log.info('[extensions] staged %s@%s -> %s', id, version, tgz)
  return { id, version, tgzPath: tgz }
}
