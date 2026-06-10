// =============================================================================
// writeJsonAtomic — the single atomic JSON write primitive for the main process.
//
// Atomic tmp+rename writes were reimplemented in a half-dozen places (jsonStateFile,
// jsonFileStore, store.ts boot snapshot, grantedPathStore, customModels, agentDir)
// and several were non-atomic (a crash mid-write left a truncated file). This is
// the one implementation everything routes through:
//   - writes to a per-write unique `<path>.<pid>.<seq>.tmp` then renames over the
//     target (atomic on the same fs; unique so concurrent writes can't collide).
//   - creates the parent dir as needed (with an optional secret 0700 mode).
//   - optionally chmods the final file to a secret 0600 mode (auth.json etc.).
//   - cleans up the tmp file on failure.
//
// Both sync and async variants exist because callers differ: quit-time flushes
// must be synchronous, everything else prefers the async path.
// =============================================================================

import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'

// Per-write unique temp suffix. A shared `<file>.tmp` is unsafe when two writes
// to the same path overlap: one consumes the tmp, the other's rename races and
// can interleave so older content lands last (or fails with ENOENT). Uniquify so
// every write owns its own tmp file and renames are independent. (Mirrors the
// projectWorkspaceStore uniqueTmpPath approach; kept here so every caller of the
// shared primitive is collision-safe by default, no opt-in required.)
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

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fsp.rename(from, to)
    } catch (err) {
      if (!isRetryableRename(err, attempt)) throw err
      await new Promise((r) => setTimeout(r, RENAME_RETRY_STEP_MS * (attempt + 1)))
    }
  }
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
  const tmp = uniqueTmpPath(filePath)
  const dirMode = mode !== undefined ? 0o700 : undefined
  await fsp.mkdir(path.dirname(filePath), { recursive: true, ...(dirMode !== undefined ? { mode: dirMode } : {}) })
  try {
    await fsp.writeFile(tmp, text, 'utf-8')
    await renameWithRetry(tmp, filePath)
    if (mode !== undefined) {
      try { await fsp.chmod(filePath, mode) } catch { /* no file modes on this platform */ }
    }
  } catch (err) {
    try { await fsp.unlink(tmp) } catch { /* noop */ }
    throw err
  }
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
