// The filesystem operations skill installs use, and the per-directory locks
// that make an install's read/modify/write of a manifest one transaction.
// Tests swap in an in-memory host.

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { KeyedLock } from '@kernel/state/contract'

export interface SkillFiles {
  readFile(file: string): Promise<string>
  readBinary(file: string): Promise<Buffer>
  writeFile(file: string, text: string): Promise<unknown>
  writeBinary(file: string, bytes: Buffer): Promise<unknown>
  mkdir(dir: string): Promise<unknown>
  remove(target: string): Promise<unknown>
  rename(from: string, to: string): Promise<unknown>
  stat(target: string): Promise<{ isDirectory: boolean; isFile: boolean }>
  readDir(dir: string): Promise<Array<{ name: string; isDirectory: boolean }>>
}

export const nodeSkillFiles: SkillFiles = {
  readFile: (file) => fs.readFile(file, 'utf8'),
  readBinary: (file) => fs.readFile(file),
  writeFile: (file, text) => fs.writeFile(file, text, 'utf8'),
  writeBinary: (file, bytes) => fs.writeFile(file, bytes),
  mkdir: (dir) => fs.mkdir(dir, { recursive: true }),
  remove: (target) => fs.rm(target, { recursive: true, force: true }),
  rename: (from, to) => fs.rename(from, to),
  stat: async (target) => {
    const stat = await fs.stat(target)
    return { isDirectory: stat.isDirectory(), isFile: stat.isFile() }
  },
  readDir: async (dir) =>
    (await fs.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() })),
}

export function isMissingError(error: unknown): boolean {
  return (
    (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') ||
    (error instanceof Error && /ENOENT|no such file/i.test(error.message))
  )
}

/** Atomic JSON publication, so readers never see a half-written manifest.
 *  Not through kernel/state: a manifest is published once through
 *  `SkillFiles`, which may be a checkout's files, never held as live state. */
export async function writeSkillJson(files: SkillFiles, destination: string, value: unknown): Promise<void> {
  const temporary = `${destination}.tmp-${randomUUID()}`
  try {
    await files.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`)
    await files.rename(temporary, destination)
  } finally {
    try { await files.remove(temporary) } catch { /* already renamed */ }
  }
}

export type WithDirs = <T>(dirs: string[], action: () => Promise<T>) => Promise<T>

/** Install, seed, uninstall and mirror hold the same lock for their whole
 *  read/modify/write transaction. Nested helpers join the held locks. */
export function createDirLocks(): WithDirs {
  const locks = new KeyedLock()
  const held = new AsyncLocalStorage<ReadonlySet<string>>()
  return function withDirs<T>(dirs: string[], action: () => Promise<T>): Promise<T> {
    const keys = [...new Set(dirs.map(dirKey))].sort()
    const acquire = (index: number): Promise<T> => {
      if (index === keys.length) return action()
      const key = keys[index]
      const current = held.getStore() ?? new Set<string>()
      if (current.has(key)) return acquire(index + 1)
      return locks.run(key, () => held.run(new Set([...current, key]), () => acquire(index + 1)))
    }
    return acquire(0)
  }
}

/** Separators normalized, trailing ones dropped; Windows paths case-folded. */
export function dirKey(dir: string): string {
  const isWindows = /^[A-Za-z]:/.test(dir) || dir.includes('\\')
  const norm = dir.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  return isWindows ? norm.toLowerCase() : norm
}
