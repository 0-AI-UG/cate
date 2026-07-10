// =============================================================================
// uploadEntries — import external (local) files/folders into a REMOTE workspace.
//
// Drag-import sources are local OS paths (webUtils.getPathForFile), but a remote
// workspace's destination lives on the runtime host. The local importEntries
// path (fs.cp on the daemon) can't see those local files, so for a remote
// runtime we read each entry on this side and stream its bytes to the host via
// `runtime.file.writeBinary`. Mirrors importEntriesInto's contract: returns the
// created runtime-absolute paths + a failure count, auto-names on collision,
// and `move` deletes the (local) source after a successful upload.
// =============================================================================

import fs from 'fs/promises'
import path from 'path'
import posix from 'path/posix'
import type { FileAccessContext, Runtime } from './types'

async function remoteExists(runtime: Runtime, p: string, access?: FileAccessContext): Promise<boolean> {
  try {
    await runtime.file.stat(p, access)
    return true
  } catch {
    return false
  }
}

/** Collision-free name for `baseName` inside the remote `destDir` (probes via stat). */
async function remoteAvailableName(runtime: Runtime, destDir: string, baseName: string, access?: FileAccessContext): Promise<string> {
  const ext = posix.extname(baseName)
  const stem = ext ? baseName.slice(0, -ext.length) : baseName
  let candidate = baseName
  let n = 2
  while (await remoteExists(runtime, posix.join(destDir, candidate), access)) {
    candidate = `${stem} (${n})${ext}`
    n++
  }
  return candidate
}

/** Upload one local entry (file or directory tree) to `remoteDest`. Skips
 *  symlinks at every level, matching the leaf fs ops' symlink policy. */
async function uploadOne(runtime: Runtime, localSrc: string, remoteDest: string, access?: FileAccessContext): Promise<void> {
  const st = await fs.lstat(localSrc)
  if (st.isSymbolicLink()) return
  if (st.isDirectory()) {
    await runtime.file.mkdir(remoteDest, access)
    for (const name of await fs.readdir(localSrc)) {
      await uploadOne(runtime, path.join(localSrc, name), posix.join(remoteDest, name), access)
    }
  } else if (st.isFile()) {
    await runtime.file.writeBinary(remoteDest, await fs.readFile(localSrc), access)
  }
}

/**
 * Import local `sources` into the remote `safeDestDir` (a runtime-absolute,
 * already-validated directory) over `runtime`. `safeDestDir` must already
 * exist on the host. Returns the created host paths (to be locator-encoded by
 * the caller) and the count of sources that failed.
 */
export async function uploadEntriesToRuntime(
  runtime: Runtime,
  sources: string[],
  safeDestDir: string,
  mode: 'copy' | 'move',
  access?: FileAccessContext,
): Promise<{ created: string[]; failed: number }> {
  const created: string[] = []
  let failed = 0

  for (const src of Array.isArray(sources) ? sources : []) {
    try {
      // Follow the dragged path to its real location (matches importEntriesInto).
      const realSrc = await fs.realpath(src)
      const name = await remoteAvailableName(runtime, safeDestDir, path.basename(realSrc), access)
      const dest = posix.join(safeDestDir, name)
      await uploadOne(runtime, realSrc, dest, access)
      if (mode === 'move') await fs.rm(realSrc, { recursive: true, force: true })
      created.push(dest)
    } catch {
      failed++
    }
  }

  return { created, failed }
}
