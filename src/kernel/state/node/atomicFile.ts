// The one atomic write primitive: write a uniquely named temporary file next to
// the target, then rename it over the target (atomic on one filesystem). Both
// sync and async variants exist because quit-time flushes must be synchronous.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export interface AtomicWriteOptions {
  /** File mode, e.g. 0o600 for secrets. The parent directory is then created
   *  with 0o700. */
  mode?: number
}

export interface WriteJsonOptions extends AtomicWriteOptions {
  /** Default true: 2-space indent and a trailing newline. */
  pretty?: boolean
}

// On Windows, renaming over a file fails with a transient EPERM/EACCES/EBUSY
// while a scanner or a racing rename holds it. POSIX rename has no such failure,
// so the retry is win32-only and real permission errors stay fast elsewhere.
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const MAX_RETRIES = 10
const RETRY_STEP_MS = 20

function isRetryable(error: unknown, attempt: number): boolean {
  if (process.platform !== 'win32' || attempt >= MAX_RETRIES) return false
  const code = (error as NodeJS.ErrnoException).code
  return code !== undefined && RETRY_CODES.has(code)
}

export async function retryFilePublish(publish: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { return await publish() } catch (error) {
      if (!isRetryable(error, attempt)) throw error
      await new Promise((resolve) => setTimeout(resolve, RETRY_STEP_MS * (attempt + 1)))
    }
  }
}

function renameWithRetrySync(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.renameSync(from, to)
    } catch (error) {
      if (!isRetryable(error, attempt)) throw error
      // Blocking sleep: this only runs on win32 during quit-time flushes.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_STEP_MS * (attempt + 1))
    }
  }
}

function temporaryPath(file: string): string {
  return `${file}.${randomUUID()}.tmp`
}

function dirOptions(mode: number | undefined): fs.MakeDirectoryOptions {
  return mode !== undefined ? { recursive: true, mode: 0o700 } : { recursive: true }
}

function serialize(value: unknown, pretty: boolean): string {
  return pretty ? JSON.stringify(value, null, 2) + '\n' : JSON.stringify(value)
}

/** Replace `file` with complete bytes, creating the parent directory. */
export async function writeFileAtomic(file: string, data: string | Uint8Array, options: AtomicWriteOptions = {}): Promise<void> {
  const { mode } = options
  await fsp.mkdir(path.dirname(file), dirOptions(mode))
  const temporary = temporaryPath(file)
  try {
    await fsp.writeFile(temporary, data, mode !== undefined ? { mode } : {})
    if (mode !== undefined) {
      await fsp.chmod(temporary, mode).catch(() => { /* filesystems without POSIX modes */ })
    }
    await retryFilePublish(() => fsp.rename(temporary, file))
  } finally {
    await fsp.unlink(temporary).catch(() => {})
  }
}

export function writeFileAtomicSync(file: string, data: string | Uint8Array, options: AtomicWriteOptions = {}): void {
  const { mode } = options
  fs.mkdirSync(path.dirname(file), dirOptions(mode))
  const temporary = temporaryPath(file)
  try {
    fs.writeFileSync(temporary, data, mode !== undefined ? { mode } : {})
    if (mode !== undefined) {
      try { fs.chmodSync(temporary, mode) } catch { /* filesystems without POSIX modes */ }
    }
    renameWithRetrySync(temporary, file)
  } finally {
    try { fs.unlinkSync(temporary) } catch { /* already renamed */ }
  }
}

export function writeJsonAtomic(file: string, value: unknown, options: WriteJsonOptions = {}): Promise<void> {
  const { pretty = true, ...rest } = options
  return writeFileAtomic(file, serialize(value, pretty), rest)
}

export function writeJsonAtomicSync(file: string, value: unknown, options: WriteJsonOptions = {}): void {
  const { pretty = true, ...rest } = options
  writeFileAtomicSync(file, serialize(value, pretty), rest)
}

/** Publish an immutable 0600 JSON record without replacing another writer's
 *  record. Linking a closed temporary file makes existence and publication
 *  atomic across processes; readers never see a partial file. */
export async function writeJsonExclusive(file: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = temporaryPath(file)
  try {
    await fsp.writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
    try { await retryFilePublish(() => fsp.link(temporary, file)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  } finally {
    await fsp.unlink(temporary).catch(() => {})
  }
}
