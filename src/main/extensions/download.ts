// =============================================================================
// Extension artifact install — download + verify + extract a catalog entry's
// .tgz into a versioned dir the proxy can serve.
//
// Layout under userData:
//   extensions/<id>/<version>/         extracted extension root (manifest.json)
//   extensions/<id>/<version>/.ok      idempotency marker (written last)
//
// Mirrors the runtime tarball pattern (see runtime/runtimeArtifacts.ts):
// fetch() -> Buffer -> write a *.part temp -> rename; sha256 via crypto; extract
// by shelling out to system `tar`. Idempotent: an existing dir + .ok short-
// circuits. On any failure the partial versioned dir is removed.
// =============================================================================

import { app } from 'electron'
import { createHash } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'fs/promises'
import log from '../logger'
import { loadManifestFromDir } from './manifest'
import { extensionsDir, type CatalogEntry } from './catalog'

const execFileAsync = promisify(execFile)

/** Extracted root dir for one (id, version). */
export function installedDir(id: string, version: string): string {
  return path.join(extensionsDir(), id, version)
}

/** True once an (id, version) is fully extracted (its .ok marker exists). */
export function isInstalled(id: string, version: string): boolean {
  return existsSync(path.join(installedDir(id, version), '.ok'))
}

/** Fall back to '0.0.0' so an unversioned manifest still installs somewhere. */
function entryVersion(entry: CatalogEntry): string {
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

/** Fetch the artifact bytes (http(s) via fetch, local via fs read). */
async function readArtifact(url: string): Promise<Buffer> {
  if (isLocal(url)) {
    return readFile(localArtifactPath(url))
  }
  const res = await fetch(url)
  if (!res.ok) throw new Error(`artifact download failed: HTTP ${res.status} (${url})`)
  return Buffer.from(await res.arrayBuffer())
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * Ensure a catalog entry is installed, returning its extracted root dir.
 * Idempotent: if the dir + .ok marker exist, returns immediately. Otherwise
 * downloads, verifies sha256 (if present), extracts the .tgz, validates the
 * extracted manifest.json, and writes .ok. Cleans up a partial dir on failure.
 */
export async function installFromCatalog(entry: CatalogEntry): Promise<string> {
  const id = entry.manifest.id
  const version = entryVersion(entry)
  const dest = installedDir(id, version)

  if (isInstalled(id, version)) return dest

  await mkdir(path.dirname(dest), { recursive: true })

  // Download the tarball to a temp file (atomic via rename), then extract into a
  // temp dir we rename into place so a half-extracted dir is never visible.
  const tgz = `${dest}.${process.pid}.tgz`
  const tmpDir = `${dest}.${process.pid}.tmp`

  try {
    const buf = await readArtifact(entry.artifactUrl)
    if (entry.sha256 && sha256(buf) !== entry.sha256.toLowerCase()) {
      throw new Error(`sha256 mismatch for ${id}@${version}`)
    }
    const tgzTmp = `${tgz}.part`
    await writeFile(tgzTmp, buf)
    await rename(tgzTmp, tgz)

    await rm(tmpDir, { recursive: true, force: true })
    await mkdir(tmpDir, { recursive: true })
    await execFileAsync('tar', ['-xzf', tgz, '-C', tmpDir])

    // The .tgz may contain the extension at its root or nested one level; accept
    // a top-level manifest.json, else a single subdir holding it.
    const root = await resolveExtractedRoot(tmpDir)
    const manifest = await loadManifestFromDir(root)
    if (!manifest) {
      throw new Error(`extracted artifact for ${id}@${version} has no valid manifest.json`)
    }

    await rm(dest, { recursive: true, force: true })
    await rename(root, dest)
    await writeFile(path.join(dest, '.ok'), '')
    log.info('[extensions] installed %s@%s -> %s', id, version, dest)
    return dest
  } catch (err) {
    await rm(dest, { recursive: true, force: true }).catch(() => {})
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    throw err instanceof Error ? err : new Error(String(err))
  } finally {
    await rm(tgz, { force: true }).catch(() => {})
  }
}

/** Pick the extracted extension root: tmpDir itself if it holds a manifest,
 *  otherwise its single subdirectory (a tar that preserved a leading folder). */
async function resolveExtractedRoot(tmpDir: string): Promise<string> {
  if (existsSync(path.join(tmpDir, 'manifest.json'))) return tmpDir
  const entries = await readdir(tmpDir, { withFileTypes: true })
  const dirs = entries.filter((e) => e.isDirectory())
  if (dirs.length === 1 && existsSync(path.join(tmpDir, dirs[0].name, 'manifest.json'))) {
    return path.join(tmpDir, dirs[0].name)
  }
  return tmpDir
}
