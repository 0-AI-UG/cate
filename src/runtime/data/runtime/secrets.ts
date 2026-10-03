// secrets.json (0600): the runtime key pair and other secret material. One
// JsonStateFile per runtime; other owners (browser passwords) add their own
// top-level fields to the same file.

import { createJsonStateFile, type JsonStateFile } from '@kernel/state/node'
import { decodeKeyPair, encodeKeyPair, generateKeyPair, type KeyPair, type StoredKeyPair } from '../../security/contract'
import { dataPaths } from './paths'

export interface SecretsFile {
  runtimeKey?: StoredKeyPair
  [key: string]: unknown
}

export function openSecretsFile(dataDir: string): JsonStateFile<SecretsFile> {
  return createJsonStateFile<SecretsFile>({
    file: dataPaths(dataDir).secrets,
    defaults: {},
    normalize: (parsed) =>
      parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...(parsed as SecretsFile) } : {},
    mode: 0o600,
  })
}

/** The runtime's static key pair, created and written on first start. */
export async function ensureRuntimeKeyPair(secrets: JsonStateFile<SecretsFile>): Promise<KeyPair> {
  const existing = decodeKeyPair(secrets.get().runtimeKey)
  if (existing) return existing
  const created = generateKeyPair()
  secrets.update((current) => ({ ...current, runtimeKey: encodeKeyPair(created) }))
  await secrets.flushDurable()
  return created
}
