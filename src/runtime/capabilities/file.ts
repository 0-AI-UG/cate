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
import { validatePathForCreation } from '../../main/ipc/pathValidation'
import type { FileTreeNode, FileSearchResult, FileSearchOptions } from '../../shared/types'

export async function readFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf-8')
}

export async function readBinary(filePath: string): Promise<Buffer> {
  return fs.readFile(filePath)
}

export async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, 'utf-8')
}

/** Write raw bytes (used by remote upload, where the source is read client-side
 *  and the contents are streamed in as a Buffer). Creates the parent directory. */
export async function writeBinary(filePath: string, data: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, data)
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
  const finalDest = await validatePathForCreation(path.join(safeDestDir, candidate))
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
  ownerWindowId: number | undefined,
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
      const finalDest = await validatePathForCreation(path.join(safeDestDir, candidate), ownerWindowId)

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
