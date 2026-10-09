// pairings.json: the devices paired with this workspace.

import { createJsonStateFile, type JsonStateFile } from '@kernel/state/node'
import { dataPaths } from '../../data/runtime'

export interface PairingRecord {
  /** hex X25519 public key */
  publicKey: string
  name: string
  pairedAt: number
  lastSeen: number
}

export interface PairingsFile {
  devices: PairingRecord[]
}

/** What the service needs from the file; a JsonStateFile satisfies it. */
export interface PairingsStore {
  get(): PairingsFile
  update(fn: (current: PairingsFile) => PairingsFile): void
  /** Every change; `external` for an edit of the file itself. */
  subscribe(listener: (next: PairingsFile, origin: 'local' | 'external') => void): () => void
}

function normalize(parsed: unknown): PairingsFile {
  const devices = (parsed as { devices?: unknown } | null)?.devices
  if (!Array.isArray(devices)) return { devices: [] }
  return {
    devices: devices.filter(
      (d): d is PairingRecord =>
        !!d &&
        typeof d.publicKey === 'string' &&
        /^[0-9a-f]{64}$/.test(d.publicKey) &&
        typeof d.name === 'string' &&
        typeof d.pairedAt === 'number' &&
        typeof d.lastSeen === 'number',
    ),
  }
}

export function openPairingsFile(dataDir: string): JsonStateFile<PairingsFile> {
  return createJsonStateFile<PairingsFile>({
    file: dataPaths(dataDir).pairings,
    defaults: { devices: [] },
    normalize,
    mode: 0o600,
  })
}
