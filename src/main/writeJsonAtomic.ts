// =============================================================================
// writeJsonAtomic — the single atomic JSON write primitive for the main process.
//
// Atomic tmp+rename writes were reimplemented in a half-dozen places (jsonStateFile,
// jsonFileStore, store.ts boot snapshot, grantedPathStore, customModels, agentDir)
// and several were non-atomic (a crash mid-write left a truncated file). This is
// the one implementation everything routes through:
//   - writes to a per-write unique temporary path then renames over the
//     target (atomic on the same fs; unique so concurrent writes can't collide).
//   - creates the parent dir as needed (with an optional secret 0700 mode).
//   - supports explicit file modes, including secret 0600 files.
//   - cleans up the tmp file on failure.
//
// Async publication is shared with runtime file writes via shared/atomicFile.
// Both sync and async variants exist because callers differ: quit-time flushes
// must be synchronous, everything else prefers the async path.
// =============================================================================

import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { writeFileAtomic } from '../shared/atomicFile'

// The quit-time synchronous writer cannot use the shared async publication
// helper; each write still needs its own temporary path.
let tmpSeq = 0
function uniqueTmpPath(filePath: string): string {
  tmpSeq = (tmpSeq + 1) & 0x7fffffff
  return `${filePath}.${process.pid}.${tmpSeq}.tmp`
}

// On Windows, renaming over an existing file is not atomic with respect to
// other replacements of the same destination: MoveFileEx(REPLACE_EXISTING)
// fails with a transient EPERM when it races another rename onto the target
// (or an antivirus/indexer briefly holds the file open). POSIX rename has no
// such failure mode, so the retry is win32-only to keep real permission
// errors fast everywhere else. Bounded backoff: 20+40+...+200ms ≈ 1.1s max.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RENAME_MAX_RETRIES = 10
const RENAME_RETRY_STEP_MS = 20

function isRetryableRename(err: unknown, attempt: number): boolean {
  if (process.platform !== 'win32' || attempt >= RENAME_MAX_RETRIES) return false
  const code = (err as NodeJS.ErrnoException).code
  return code !== undefined && RENAME_RETRY_CODES.has(code)
}

function renameWithRetrySync(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.renameSync(from, to)
    } catch (err) {
      if (!isRetryableRename(err, attempt)) throw err
      // Blocking sleep: this path only runs at quit-time flushes on win32.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_RETRY_STEP_MS * (attempt + 1))
    }
  }
}

export interface WriteJsonAtomicOptions {
  /** File mode for the written file (e.g. 0o600 for secrets). The parent dir is
   *  created with 0o700 when a secret mode is requested. */
  mode?: number
  /** Override JSON.stringify formatting. Defaults to 2-space pretty-print + a
   *  trailing newline (keeps hand-editable files tidy). Pass `pretty: false` for
   *  a compact single-line write. */
  pretty?: boolean
}

function serialize(value: unknown, pretty: boolean): string {
  return pretty ? JSON.stringify(value, null, 2) + '\n' : JSON.stringify(value)
}

/** Atomically write raw text (or raw bytes) to `filePath` (tmp + rename). Async.
 *  The JSON helpers below serialize and delegate here; agentDir writes
 *  pre-serialized credential text through this directly, and the canvas
 *  background store writes image bytes through it as a Buffer. The 'utf-8'
 *  encoding hint is ignored by Node when `text` is a Buffer. */
export async function writeTextAtomic(
  filePath: string,
  text: string | Buffer,
  options: Pick<WriteJsonAtomicOptions, 'mode'> = {},
): Promise<void> {
  const { mode } = options
  const dirMode = mode !== undefined ? 0o700 : undefined
  await fsp.mkdir(path.dirname(filePath), { recursive: true, ...(dirMode !== undefined ? { mode: dirMode } : {}) })
  await writeFileAtomic(filePath, text, mode)
}

/** Atomically write raw text to `filePath` (tmp + rename). Synchronous. */
export function writeTextAtomicSync(
  filePath: string,
  text: string,
  options: Pick<WriteJsonAtomicOptions, 'mode'> = {},
): void {
  const { mode } = options
  const tmp = uniqueTmpPath(filePath)
  const dirMode = mode !== undefined ? 0o700 : undefined
  fs.mkdirSync(path.dirname(filePath), { recursive: true, ...(dirMode !== undefined ? { mode: dirMode } : {}) })
  try {
    fs.writeFileSync(tmp, text, 'utf-8')
    renameWithRetrySync(tmp, filePath)
    if (mode !== undefined) {
      try { fs.chmodSync(filePath, mode) } catch { /* no file modes on this platform */ }
    }
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* noop */ }
    throw err
  }
}

/** Atomically write `value` as JSON to `filePath` (tmp + rename). Async. */
export function writeJsonAtomic(
  filePath: string,
  value: unknown,
  options: WriteJsonAtomicOptions = {},
): Promise<void> {
  const { pretty = true, ...rest } = options
  return writeTextAtomic(filePath, serialize(value, pretty), rest)
}

/** Atomically write `value` as JSON to `filePath` (tmp + rename). Synchronous —
 *  for quit-time flushes that must complete before the process exits. */
export function writeJsonAtomicSync(
  filePath: string,
  value: unknown,
  options: WriteJsonAtomicOptions = {},
): void {
  const { pretty = true, ...rest } = options
  writeTextAtomicSync(filePath, serialize(value, pretty), rest)
}
