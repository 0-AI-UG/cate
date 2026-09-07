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
