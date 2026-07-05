// =============================================================================
// Extension artifact install — daemon (host) side. Resolves the per-host
// extensions root and extracts a verified .tgz into a versioned dir, ON the host
// that owns the workspace (local OR remote — only the daemon knows its own home
// dir). This is the single, branch-free install path: the client fetches +
// sha256-verifies the artifact, writeBinary's the .tgz here, then calls
// extractArtifact; the proxy serves and the server spawns from the same host dir.
//
// Layout under the host home:
//   ~/.cate/extensions/<id>/<version>/        extracted extension root
//   ~/.cate/extensions/<id>/<version>/.ok     idempotency marker (written last)
//
// Electron-free (no electron/settings/window imports) so it bundles into the
// standalone daemon, exactly like ./file. Extraction shells the host `tar`, the
// same dependency the client-side installer used before.
// =============================================================================

import { execFile } from 'child_process'
import { promisify } from 'util'
import os from 'os'
import path from 'path'
import { existsSync } from 'fs'
import { mkdir, readdir, realpath, rename, rm, writeFile } from 'fs/promises'

const execFileAsync = promisify(execFile)

/** Per-host extensions install root: ~/.cate/extensions. The daemon owns it —
 *  only the daemon can resolve its own home dir — so local and remote resolve it
 *  identically. The daemon registers this as an allowed root (at startup and in
 *  the extensionsRoot capability) so reads/writes/server-cwd under it validate.
 *  CATE_EXTENSIONS_ROOT overrides it (tests point this at a temp dir; never set
 *  in production, where the homedir path is correct). */
export function hostExtensionsRoot(): string {
  return process.env.CATE_EXTENSIONS_ROOT || path.join(os.homedir(), '.cate', 'extensions')
}

/**
 * List a .tgz's members as BARE paths, one per line. `tar -tzf` (WITHOUT the
 * verbose `v`) prints exactly the member path per line — no mode/owner/size
 * columns — so the WHOLE line IS the name. This avoids the fragile last-field
 * parse of `tar -tzvf`, whose columns break when a member name contains spaces
 * (e.g. "x ../../evil" would parse down to just "evil" and miss the `..`).
 */
async function listTarballMembers(tgz: string): Promise<string[]> {
  const { stdout } = await execFileAsync('tar', ['-tzf', tgz])
  return stdout
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.length > 0)
}

/**
 * Reject a member NAME that would escape the extraction dir: an absolute path,
 * a leading `/`, or any `..` path segment ("zip slip" traversal). The whole
 * `name` is the authoritative member path (from `tar -tzf`), so we split on `/`
 * and reject a `..` segment directly — no field-splitting guesswork, robust to
 * spaces in names. Exported for direct unit testing. Throws on the first offender.
 */
export function assertSafeMemberName(name: string): void {
  if (path.isAbsolute(name) || name.startsWith('/')) {
    throw new Error(`unsafe tar entry (absolute path): ${name}`)
  }
  if (name.split('/').includes('..')) {
    throw new Error(`unsafe tar entry (path traversal): ${name}`)
  }
}

/**
 * Inspect a .tgz's member list BEFORE extracting and reject anything dangerous:
 * a path that escapes the extraction dir (absolute or `..` traversal — "zip
 * slip"), or a symlink / hardlink / device / other non-regular entry (a symlink
 * could redirect a later member's write outside the dir). Only plain files and
 * directories are allowed.
 *
 * Names come from `tar -tzf` (bare, unambiguous — see listTarballMembers) and are
 * validated with assertSafeMemberName; entry TYPE comes from a SEPARATE verbose
 * `tar -tzvf` pass, whose first char is the mode type (`-` file, `d` dir, `l`
 * symlink, `h` hardlink, etc.). The name check no longer depends on the fragile
 * verbose column layout. Throws on the first offender. Ported from the former
 * client-side installer so the check runs on whichever host extracts the bytes.
 */
async function assertSafeTarball(tgz: string): Promise<void> {
  // 1) Names: bare listing, whole line = member path.
  for (const name of await listTarballMembers(tgz)) {
    assertSafeMemberName(name)
  }
  // 2) Types: verbose listing, only the leading type char is consulted.
  const { stdout } = await execFileAsync('tar', ['-tzvf', tgz])
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trimEnd()
    if (!line) continue
    const typeChar = line[0]
    if (typeChar !== '-' && typeChar !== 'd') {
      throw new Error(`unsafe tar entry (type '${typeChar}'): ${line}`)
    }
  }
}

/**
 * POST-extraction safety net (defense in depth): even if a member somehow slips
 * past the listing parse, assert nothing landed outside `tmpDir`. Independent of
 * tar's text formatting — it resolves real paths and does path math against the
 * canonical tmpDir. Two complementary checks:
 *   (a) re-list the archive and resolve each member against the canonical tmpDir;
 *       a `..` name resolves OUTSIDE tmpDir → reject (catches name traversal that
 *       actually landed as a sibling of tmpDir);
 *   (b) walk the extracted tree and realpath every entry, asserting it stays
 *       within the canonical tmpDir (catches any symlink-mediated escape).
 * Throws if anything escaped; extractArtifact's catch then rms destDir.
 */
async function assertExtractionContained(tgz: string, tmpDir: string): Promise<void> {
  const realTmp = await realpath(tmpDir)
  const within = (p: string) => p === realTmp || p.startsWith(realTmp + path.sep)

  // (a) Where each member WOULD land, resolved against the canonical tmpDir.
  for (const name of await listTarballMembers(tgz)) {
    const resolved = path.resolve(realTmp, name)
    if (!within(resolved)) {
      throw new Error(`unsafe tar entry (escapes extraction dir): ${name}`)
    }
  }

  // (b) Every real extracted path stays inside the canonical tmpDir.
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const full = path.join(dir, e.name)
      const real = await realpath(full)
      if (!within(real)) {
        throw new Error(`extracted path escapes extraction dir: ${full}`)
      }
      if (e.isDirectory()) await walk(full)
    }
  }
  await walk(realTmp)
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

/**
 * Validate + extract a .tgz already present on the host (written via
 * file.writeBinary) into `destDir`, atomically. Rejects unsafe members, extracts
 * into a sibling temp dir, requires a top-level (or single-nested) manifest.json,
 * renames into place, and writes the `.ok` marker last. Returns `destDir`. The
 * .tgz is removed afterward (success or failure). Idempotency (skip when `.ok`
 * already present) is the caller's job — it avoids re-uploading the bytes.
 */
export async function extractArtifact(tgzPath: string, destDir: string): Promise<string> {
  await mkdir(path.dirname(destDir), { recursive: true })
  const tmpDir = `${destDir}.${process.pid}.tmp`
  try {
    await assertSafeTarball(tgzPath)
    await rm(tmpDir, { recursive: true, force: true })
    await mkdir(tmpDir, { recursive: true })
    await execFileAsync('tar', ['-xzf', tgzPath, '-C', tmpDir])
    await assertExtractionContained(tgzPath, tmpDir)

    const root = await resolveExtractedRoot(tmpDir)
    if (!existsSync(path.join(root, 'manifest.json'))) {
      throw new Error('extracted artifact has no manifest.json')
    }

    await rm(destDir, { recursive: true, force: true })
    await rename(root, destDir)
    await writeFile(path.join(destDir, '.ok'), '')
    return destDir
  } catch (err) {
    await rm(destDir, { recursive: true, force: true }).catch(() => {})
    throw err instanceof Error ? err : new Error(String(err))
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    await rm(tgzPath, { force: true }).catch(() => {})
  }
}
