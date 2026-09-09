import { randomUUID } from 'node:crypto'
import { hostJoin } from '../../main/cateApi/hostPath'
import { AsyncLocalStorage } from 'node:async_hooks'
import { KeyedLock } from '../../main/keyedLock'
import { parseLocator } from '../../shared/runtimeLocator'
import { pathKey } from '../../shared/pathUtils'
import type { FileAccessContext, Runtime } from '../../main/runtime/types'

/** Only the filesystem capability is exposed to bundle/manifest operations. */
export interface SkillFileHost {
  file: {
    readFile(path: string): Promise<string>
    readBinary(path: string): Promise<Buffer>
    writeFile(path: string, text: string): Promise<unknown>
    writeBinary(path: string, bytes: Buffer): Promise<unknown>
    mkdir(path: string): Promise<unknown>
    remove(path: string): Promise<unknown>
    rename(from: string, to: string): Promise<unknown>
    stat(path: string): Promise<{ isDirectory: boolean; isFile: boolean }>
    readDir(path: string): Promise<Array<{ name: string; isDirectory: boolean }>>
  }
}
export function scopedSkillFiles(runtime: Runtime, access?: FileAccessContext): SkillFileHost {
  return { file: {
    readFile: path => runtime.file.readFile(path, access),
    readBinary: path => runtime.file.readBinary(path, access),
    writeFile: (path, text) => runtime.file.writeFile(path, text, access),
    writeBinary: (path, bytes) => runtime.file.writeBinary(path, bytes, access),
    mkdir: path => runtime.file.mkdir(path, access),
    remove: path => runtime.file.remove(path, access),
    rename: (from, to) => runtime.file.rename(from, to, access),
    stat: path => runtime.file.stat(path, access),
    readDir: path => runtime.file.readDir(path, access),
  } }
}
const locks = new KeyedLock()
const heldLocks = new AsyncLocalStorage<ReadonlySet<string>>()
/** Install, seed, uninstall and mirror use the same lock for their whole
 * read/modify/write transaction. Nested helpers join the existing transaction. */
export function withSkillWorkspaces<T>(locators: string[], action: () => Promise<T>): Promise<T> {
  const keys = [...new Set(locators.map(locator => {
    const { runtimeId, path } = parseLocator(locator)
    return `${runtimeId}:${pathKey(hostJoin(runtimeId, path))}`
  }))].sort()
  const acquire = (index: number): Promise<T> => {
    if (index === keys.length) return action()
    const key = keys[index]
    const held = heldLocks.getStore() ?? new Set<string>()
    if (held.has(key)) return acquire(index + 1)
    return locks.run(key, () => heldLocks.run(new Set([...held, key]), () => acquire(index + 1)))
  }
  return acquire(0)
}

/** Atomic JSON publication prevents read-only consumers seeing a half-written
 * manifest; workspace locking separately protects its read/modify/write cycle. */
export async function writeSkillJson(host: SkillFileHost, destination: string, value: unknown): Promise<void> {
  const temporary = `${destination}.tmp-${randomUUID()}`
  try {
    await host.file.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`)
    await host.file.rename(temporary, destination)
  } finally {
    try { await host.file.remove(temporary) } catch { /* already renamed */ }
  }
}
