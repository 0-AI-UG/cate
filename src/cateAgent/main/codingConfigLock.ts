// =============================================================================
// codingConfigLock — shared access to the pi agent's config JSON files
// (auth.json, models.json). Both files are co-owned with the external pi CLI,
// so reads are lenient (missing/corrupt → null, callers merge-preserve keys
// they don't own) and writes are atomic, serialized per file, and 0600 —
// auth.json holds API keys and models.json can hold a custom endpoint's key.
// =============================================================================

import fsp from 'fs/promises'
import path from 'path'
import { KeyedLock } from '../../main/keyedLock'
import log from '../../main/logger'
import { isPlainObject } from '../../main/jsonUtils'
import { writeJsonAtomic } from '../../main/writeJsonAtomic'

/** Serializes writes to shared agent configuration files by filename. */
export const codingConfigLock = new KeyedLock()

/** Read a shared agent config JSON file. Returns null when the file is
 *  missing, unparseable, or not a JSON object; non-ENOENT failures are logged. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readCodingConfigFile(filePath: string): Promise<Record<string, any> | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(filePath, 'utf-8'))
    if (isPlainObject(parsed)) return parsed
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log.warn('[agentConfig] failed to read %s: %O', filePath, err)
    }
  }
  return null
}

/** Read-modify-write a shared agent config JSON file under its per-file lock
 *  (keyed by basename, matching the keys agentDir uses for the same files).
 *  `update` receives the current contents ({} when missing/corrupt) and returns
 *  the object to persist, so keys owned by other writers (the pi CLI, hand
 *  edits) survive. Written atomically with mode 0600. */
export async function updateCodingConfigFile(
  filePath: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update: (current: Record<string, any>) => Record<string, any>,
): Promise<void> {
  await codingConfigLock.run(path.basename(filePath), async () => {
    const current = (await readCodingConfigFile(filePath)) ?? {}
    await writeJsonAtomic(filePath, update(current), { mode: 0o600 })
  })
}
