// =============================================================================
// File capability — electron-free filesystem leaf operations over validated,
// runtime-absolute paths. This is the SINGLE SOURCE for the fs logic: the
// Electron main process (src/main/ipc/filesystem.ts) wraps these injecting the
// live `fileExclusions` setting, and the standalone runtime daemon
// (src/runtime/index.ts) wraps them with its configured exclusion set. No
// electron / settings / window imports here, so it bundles into the daemon.
// =============================================================================

import fs from 'fs/promises'
import path from 'path'
import type { FileTreeNode, FileSearchResult, FileSearchOptions } from '../../shared/types'

export async function readFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf-8')
}

export async function readBinary(filePath: string): Promise<Buffer> {
  return fs.readFile(filePath)
}

/** Refuse to write THROUGH a symlink: path validation realpaths the parent
 *  chain but the final segment may not exist yet, so an existing symlink
 *  basename would otherwise redirect the write outside the validated location.
 *  Mirrors statEntry/removeEntry, which likewise reject symlinks. */
async function assertNotSymlink(filePath: string): Promise<void> {
  const stat = await fs.lstat(filePath).catch(() => null) // missing target — fine
  if (stat?.isSymbolicLink()) {
    throw new Error(`Access denied: "${filePath}" is a symbolic link`)
  }
}

// ---------------------------------------------------------------------------
// Atomic writes — every write through the runtime is tmp+rename, so a crash
// mid-write can never leave a truncated file, on any host. This mirrors the
// main process's writeJsonAtomic (src/main/writeJsonAtomic.ts): per-write
// unique tmp in the same directory (rename is atomic on the same fs; unique so
// concurrent writes can't consume each other's tmp), win32 rename retry for
// the transient EPERM that MoveFileEx(REPLACE_EXISTING) hits when racing an
// antivirus/indexer handle. The target's existing mode is copied onto the tmp
// BEFORE the rename (a plain write preserves the inode's mode; a rename
// replaces the inode — without this an editor save would strip a script's
// executable bit).
// ---------------------------------------------------------------------------

let tmpSeq = 0
function uniqueTmpPath(filePath: string): string {
  tmpSeq = (tmpSeq + 1) & 0x7fffffff
  return `${filePath}.${process.pid}.${tmpSeq}.tmp`
}

const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RENAME_MAX_RETRIES = 10
const RENAME_RETRY_STEP_MS = 20

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.rename(from, to)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const retryable =
        process.platform === 'win32' &&
        attempt < RENAME_MAX_RETRIES &&
        code !== undefined &&
        RENAME_RETRY_CODES.has(code)
      if (!retryable) throw err
      await new Promise((r) => setTimeout(r, RENAME_RETRY_STEP_MS * (attempt + 1)))
    }
  }
}

async function writeAtomic(filePath: string, data: string | Buffer): Promise<void> {
  await assertNotSymlink(filePath)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const existingMode = await fs
    .stat(filePath)
    .then((s) => s.mode & 0o7777)
    .catch(() => null) // no existing file — the tmp's default mode applies
  const tmp = uniqueTmpPath(filePath)
  try {
    await fs.writeFile(tmp, data, 'utf-8') // encoding ignored for Buffers
    if (existingMode !== null) {
      await fs.chmod(tmp, existingMode).catch(() => { /* no modes on this fs */ })
    }
    await renameWithRetry(tmp, filePath)
  } catch (err) {
    await fs.unlink(tmp).catch(() => { /* never written */ })
    throw err
  }
}

export async function writeFile(filePath: string, content: string): Promise<void> {
  await writeAtomic(filePath, content)
}

/** Write raw bytes (used by remote upload, where the source is read client-side
 *  and the contents are streamed in as a Buffer). Creates the parent directory. */
export async function writeBinary(filePath: string, data: Buffer): Promise<void> {
  await writeAtomic(filePath, data)
}

/** lstat + reject symlinks, returning the directory/file discriminator. */
export async function statEntry(safePath: string): Promise<{ isDirectory: boolean; isFile: boolean }> {
  const stat = await fs.lstat(safePath)
  if (stat.isSymbolicLink()) {
    throw new Error(`Access denied: "${safePath}" is a symbolic link`)
  }
  return { isDirectory: stat.isDirectory(), isFile: stat.isFile() }
}

/** Delete a file or directory; never follows a symlink (unlinks it directly). */
export async function removeEntry(safePath: string): Promise<void> {
  const stat = await fs.lstat(safePath)
  if (stat.isSymbolicLink()) {
    await fs.unlink(safePath)
  } else if (stat.isDirectory()) {
    await fs.rm(safePath, { recursive: true })
  } else {
    await fs.unlink(safePath)
  }
}

export async function renameEntry(safeOldPath: string, safeNewPath: string): Promise<void> {
  await fs.rename(safeOldPath, safeNewPath)
}

export async function mkdirEntry(safePath: string): Promise<void> {
  await fs.mkdir(safePath, { recursive: true })
}

/**
 * Read a single level of a directory, building FileTreeNode[]. Skips hidden
 * files, the supplied exclusion set (matched by basename), and symlinks. Sorts
 * directories first, then files, each case-insensitive.
 */
export async function readDir(dirPath: string, exclusions: Set<string>): Promise<FileTreeNode[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(dirPath)
  } catch {
    return []
  }

  const dirs: FileTreeNode[] = []
  const files: FileTreeNode[] = []

  for (const entry of entries) {
    if (exclusions.has(entry)) continue

    const fullPath = path.join(dirPath, entry)
    let stat
    try {
      stat = await fs.lstat(fullPath)
    } catch {
      continue
    }
    if (stat.isSymbolicLink()) continue

    const isDirectory = stat.isDirectory()
    const ext = isDirectory ? '' : path.extname(entry).replace(/^\./, '')
    const node: FileTreeNode = {
      name: entry,
      path: fullPath,
      isDirectory,
      isExpanded: false,
      children: [],
      fileExtension: ext,
    }
    if (isDirectory) dirs.push(node)
    else files.push(node)
  }

  const caseInsensitiveSort = (a: FileTreeNode, b: FileTreeNode): number =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  dirs.sort(caseInsensitiveSort)
  files.sort(caseInsensitiveSort)
  return [...dirs, ...files]
}

export async function searchFiles(
  rootPath: string,
  query: string,
  exclusions: Set<string>,
  opts: FileSearchOptions = {},
): Promise<FileSearchResult[]> {
  const maxResults = opts.maxResults ?? 200
  const lowerQuery = query.toLowerCase()
  const allowDotFiles = query.startsWith('.')
  // Name-only search: the quick file finder behind Cmd+K matches file *names*,
  // never contents. (In-file content search is the separate ripgrep-backed
  // Search view — see runRipgrepSearch in ../search/engine.ts.) An empty query
  // matches everything, letting the palette list a sample of the workspace's
  // files when nothing is typed.
  const results: FileSearchResult[] = []
  const walk = async (dir: string): Promise<void> => {
    if (results.length >= maxResults) return
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      return
    }

    const subdirs: string[] = []
    for (const entry of entries) {
      if (results.length >= maxResults) break
      if (exclusions.has(entry)) continue
      if (!allowDotFiles && entry.startsWith('.')) continue
      const full = path.join(dir, entry)
      let stat
      try {
        stat = await fs.lstat(full)
      } catch {
        continue
      }
      if (stat.isSymbolicLink()) continue

      const isDirectory = stat.isDirectory()
      if (entry.toLowerCase().includes(lowerQuery)) {
        const relativePath = path.relative(rootPath, full).split(path.sep).join('/')
        results.push({ name: entry, path: full, relativePath, isDirectory, nameMatch: true })
      }
      if (isDirectory) subdirs.push(full)
    }

    for (const sub of subdirs) {
      if (results.length >= maxResults) return
      await walk(sub)
    }
  }

  await walk(rootPath)
  results.sort((a, b) => a.relativePath.length - b.relativePath.length)
  return results
}

async function nextAvailableName(destDir: string, baseName: string, intoSameDir: boolean): Promise<string> {
  const ext = path.extname(baseName)
  const stem = ext ? baseName.slice(0, -ext.length) : baseName
  let candidate = intoSameDir ? `${stem} copy${ext}` : baseName
  let n = 2
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await fs.lstat(path.join(destDir, candidate))
    } catch {
      return candidate
    }
    candidate = intoSameDir ? `${stem} copy ${n}${ext}` : `${stem} (${n})${ext}`
    n++
  }
}

export async function copyInto(safeSrc: string, safeDestDir: string): Promise<string> {
  const intoSameDir = path.dirname(safeSrc) === safeDestDir
  const candidate = await nextAvailableName(safeDestDir, path.basename(safeSrc), intoSameDir)
  const finalDest = path.join(safeDestDir, candidate)
  if (finalDest === safeSrc || finalDest.startsWith(safeSrc + path.sep)) {
    throw new Error('Cannot copy a folder into itself')
  }
  await fs.cp(safeSrc, finalDest, { recursive: true, errorOnExist: true, force: false })
  return finalDest
}

export async function importEntriesInto(
  sources: string[],
  safeDestDir: string,
  mode: 'copy' | 'move',
  onError: (src: string, error: unknown) => void,
): Promise<{ created: string[]; failed: number }> {
  const created: string[] = []
  let failed = 0

  for (const src of Array.isArray(sources) ? sources : []) {
    try {
      const realSrc = await fs.realpath(src)
      if (safeDestDir === realSrc || safeDestDir.startsWith(realSrc + path.sep)) {
        throw new Error('Cannot import a folder into itself')
      }
      const intoSameDir = path.dirname(realSrc) === safeDestDir
      const candidate = await nextAvailableName(safeDestDir, path.basename(realSrc), intoSameDir)
      const finalDest = path.join(safeDestDir, candidate)

      if (mode === 'move') {
        try {
          await fs.rename(realSrc, finalDest)
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code === 'EXDEV') {
            await fs.cp(realSrc, finalDest, { recursive: true, errorOnExist: true, force: false })
            await fs.rm(realSrc, { recursive: true, force: true })
          } else {
            throw err
          }
        }
      } else {
        await fs.cp(realSrc, finalDest, { recursive: true, errorOnExist: true, force: false })
      }
      created.push(finalDest)
    } catch (error) {
      failed++
      onError(src, error)
    }
  }

  return { created, failed }
}
