// =============================================================================
// writeJsonAtomic — the single atomic JSON write primitive for the main process.
//
// Atomic tmp+rename writes were reimplemented in a half-dozen places (jsonStateFile,
// jsonFileStore, store.ts boot snapshot, grantedPathStore, customModels, agentDir)
// and several were non-atomic (a crash mid-write left a truncated file). This is
// the one implementation everything routes through:
//   - writes to `<path>.tmp` then renames over the target (atomic on the same fs).
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

/** Atomically write raw text to `filePath` (tmp + rename). Async. The JSON
 *  helpers below serialize and delegate here; agentDir writes pre-serialized
 *  credential text through this directly. */
export async function writeTextAtomic(
  filePath: string,
  text: string,
  options: Pick<WriteJsonAtomicOptions, 'mode'> = {},
): Promise<void> {
  const { mode } = options
  const tmp = filePath + '.tmp'
  const dirMode = mode !== undefined ? 0o700 : undefined
  await fsp.mkdir(path.dirname(filePath), { recursive: true, ...(dirMode !== undefined ? { mode: dirMode } : {}) })
  try {
    await fsp.writeFile(tmp, text, 'utf-8')
    await fsp.rename(tmp, filePath)
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
  const tmp = filePath + '.tmp'
  const dirMode = mode !== undefined ? 0o700 : undefined
  fs.mkdirSync(path.dirname(filePath), { recursive: true, ...(dirMode !== undefined ? { mode: dirMode } : {}) })
  try {
    fs.writeFileSync(tmp, text, 'utf-8')
    fs.renameSync(tmp, filePath)
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
