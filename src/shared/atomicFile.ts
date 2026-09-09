import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** Windows scanners can briefly prevent publishing an otherwise complete file. */
export async function retryFilePublish(publish: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { return await publish() } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (process.platform !== 'win32' || attempt >= 10 || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) throw error
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)))
    }
  }
}

/** Replace a file with complete bytes. Callers own directory creation and path
 * authorization; the optional mode is applied before the file is published. */
export async function writeFileAtomic(file: string, data: string | Buffer, mode?: number): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, data, { encoding: 'utf8', ...(mode !== undefined ? { mode } : {}) })
    if (mode !== undefined) {
      await fs.chmod(temporary, mode).catch(() => { /* filesystems without POSIX modes */ })
    }
    await retryFilePublish(() => fs.rename(temporary, file))
  } finally {
    await fs.unlink(temporary).catch(() => {})
  }
}

/** Publish a complete immutable JSON record without replacing another writer's
 * record. Linking a closed temporary file makes existence + publication atomic
 * across processes; readers never observe a partially written JSON file. */
export async function writeJsonExclusive(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
    try { await retryFilePublish(() => fs.link(temporary, file)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  } finally {
    await fs.unlink(temporary).catch(() => {})
  }
}

/** Synchronous exclusive publication for startup leases. Return whether this
 * caller won; unlike ordinary replacement, an existing owner is never changed. */
export function writeJsonExclusiveSync(file: string, value: unknown): boolean {
  fsSync.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    fsSync.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    try { fsSync.linkSync(temporary, file); return true }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error }
  } finally {
    try { fsSync.unlinkSync(temporary) } catch { /* absent or best-effort cleanup */ }
  }
}
