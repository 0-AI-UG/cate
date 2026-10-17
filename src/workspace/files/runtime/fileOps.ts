// Leaf filesystem operations over paths the path scope already validated.

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { writeFileAtomic } from '@kernel/state/node'
import type { FileEntry, FileSearchResult, FileStat } from '../contract'

/** Refuses to write through a symlink: validation resolves the parent chain
 *  only, so an existing symlink basename would redirect the write. */
async function assertNotSymlink(filePath: string): Promise<void> {
  const stat = await fs.lstat(filePath).catch(() => null)
  if (stat?.isSymbolicLink()) throw new Error(`Access denied: "${filePath}" is a symbolic link`)
}

/** Atomic publication that keeps the existing mode, so saving a script keeps
 *  its executable bit when the inode is replaced. */
export async function writeAtomic(filePath: string, data: string | Uint8Array): Promise<void> {
  await assertNotSymlink(filePath)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const existingMode = await fs.stat(filePath).then((s) => s.mode & 0o7777).catch(() => null)
  await writeFileAtomic(filePath, data, existingMode !== null ? { mode: existingMode } : {})
}

/** The file's bytes, or null when it does not exist. */
export async function readBytesOrNull(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export async function statEntry(safePath: string): Promise<FileStat> {
  const stat = await fs.lstat(safePath)
  if (stat.isSymbolicLink()) throw new Error(`Access denied: "${safePath}" is a symbolic link`)
  return { isDirectory: stat.isDirectory(), isFile: stat.isFile(), size: stat.size, mtimeMs: stat.mtimeMs }
}

/** Deletes a file or directory; a symlink is unlinked, never followed. */
export async function removeEntry(safePath: string): Promise<void> {
  const stat = await fs.lstat(safePath)
  if (stat.isDirectory() && !stat.isSymbolicLink()) await fs.rm(safePath, { recursive: true })
  else await fs.unlink(safePath)
}

/** One level of a directory: hidden names are kept, exclusions and symlinks
 *  skipped; directories first, each sorted case-insensitively. */
export async function readDir(dirPath: string, exclusions: ReadonlySet<string>): Promise<FileEntry[]> {
  let names: string[]
  try {
    names = await fs.readdir(dirPath)
  } catch {
    return []
  }
  const dirs: FileEntry[] = []
  const files: FileEntry[] = []
  for (const name of names) {
    if (exclusions.has(name)) continue
    const full = path.join(dirPath, name)
    const stat = await fs.lstat(full).catch(() => null)
    if (!stat || stat.isSymbolicLink()) continue
    const isDirectory = stat.isDirectory()
    const entry: FileEntry = { name, path: full, isDirectory, extension: isDirectory ? '' : path.extname(name).replace(/^\./, '') }
    ;(isDirectory ? dirs : files).push(entry)
  }
  const byName = (a: FileEntry, b: FileEntry) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  return [...dirs.sort(byName), ...files.sort(byName)]
}

/** Name-only search behind the quick finder. An empty query matches
 *  everything, so the finder can list a sample of the workspace. Dotfiles
 *  only match a query starting with a dot. */
export async function searchFileNames(
  rootPath: string,
  query: string,
  exclusions: ReadonlySet<string>,
  maxResults = 200,
): Promise<FileSearchResult[]> {
  const lowerQuery = query.toLowerCase()
  const allowDotFiles = query.startsWith('.')
  const results: FileSearchResult[] = []
  const walk = async (dir: string): Promise<void> => {
    if (results.length >= maxResults) return
    let names: string[]
    try {
      names = await fs.readdir(dir)
    } catch {
      return
    }
    const subdirs: string[] = []
    for (const name of names) {
      if (results.length >= maxResults) break
      if (exclusions.has(name)) continue
      if (!allowDotFiles && name.startsWith('.')) continue
      const full = path.join(dir, name)
      const stat = await fs.lstat(full).catch(() => null)
      if (!stat || stat.isSymbolicLink()) continue
      const isDirectory = stat.isDirectory()
      if (name.toLowerCase().includes(lowerQuery)) {
        const relativePath = path.relative(rootPath, full).split(path.sep).join('/')
        results.push({ name, path: full, relativePath, isDirectory })
      }
      if (isDirectory) subdirs.push(full)
    }
    for (const sub of subdirs) {
      if (results.length >= maxResults) return
      await walk(sub)
    }
  }
  await walk(rootPath)
  return results.sort((a, b) => a.relativePath.length - b.relativePath.length)
}

/** A free name for `baseName` in `destDir`: "a copy.txt", "a copy 2.txt" when
 *  copying within one directory, otherwise "a (2).txt". */
export async function nextAvailableName(destDir: string, baseName: string, intoSameDir: boolean): Promise<string> {
  const ext = path.extname(baseName)
  const stem = ext ? baseName.slice(0, -ext.length) : baseName
  let candidate = intoSameDir ? `${stem} copy${ext}` : baseName
  for (let n = 2; ; n++) {
    const taken = await fs.lstat(path.join(destDir, candidate)).then(() => true, () => false)
    if (!taken) return candidate
    candidate = intoSameDir ? `${stem} copy ${n}${ext}` : `${stem} (${n})${ext}`
  }
}

export async function copyInto(safeSrc: string, safeDestDir: string): Promise<string> {
  const intoSameDir = path.dirname(safeSrc) === safeDestDir
  const finalDest = path.join(safeDestDir, await nextAvailableName(safeDestDir, path.basename(safeSrc), intoSameDir))
  if (finalDest === safeSrc || finalDest.startsWith(safeSrc + path.sep)) throw new Error('Cannot copy a folder into itself')
  await fs.cp(safeSrc, finalDest, { recursive: true, errorOnExist: true, force: false })
  return finalDest
}

/** Moves an entry to the OS trash of this machine: `~/.Trash` on macOS, the
 *  freedesktop trash on Linux. Returns false where there is none (Windows,
 *  a trash on another device); the caller then deletes permanently. */
export async function moveToTrash(safePath: string, home = os.homedir(), platform = process.platform): Promise<boolean> {
  const name = path.basename(safePath)
  try {
    if (platform === 'darwin') {
      const trash = path.join(home, '.Trash')
      await fs.mkdir(trash, { recursive: true })
      await fs.rename(safePath, path.join(trash, await nextAvailableName(trash, name, false)))
      return true
    }
    if (platform === 'linux') {
      const trash = path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'Trash')
      await fs.mkdir(path.join(trash, 'files'), { recursive: true })
      await fs.mkdir(path.join(trash, 'info'), { recursive: true })
      const target = await nextAvailableName(path.join(trash, 'files'), name, false)
      const info = `[Trash Info]\nPath=${encodeURI(safePath)}\nDeletionDate=${new Date().toISOString().slice(0, 19)}\n`
      await fs.writeFile(path.join(trash, 'info', `${target}.trashinfo`), info)
      try {
        await fs.rename(safePath, path.join(trash, 'files', target))
      } catch (err) {
        await fs.rm(path.join(trash, 'info', `${target}.trashinfo`), { force: true })
        throw err
      }
      return true
    }
  } catch (err) {
    // A trash on another filesystem cannot take a rename.
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') return false
    throw err
  }
  return false
}
