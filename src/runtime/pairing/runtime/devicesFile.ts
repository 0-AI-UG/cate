// devices.json: every device that has opened this workspace, with how it
// was admitted (architecture 7.6).

import { createJsonStateFile, type JsonStateFile } from '@kernel/state/node'
import { isDeviceKey, type DeviceAdmission } from '../contract'
import { dataPaths } from '../../data/runtime'

export interface DeviceRecord {
  /** hex X25519 public key */
  publicKey: string
  name: string
  admittedBy: DeviceAdmission
  addedAt: number
  lastSeen: number
}

export interface DevicesFile {
  devices: DeviceRecord[]
}

/** What the service needs from the file; a JsonStateFile satisfies it. */
export interface DevicesStore {
  get(): DevicesFile
  update(fn: (current: DevicesFile) => DevicesFile): void
  /** Every change; `external` for an edit of the file itself. */
  subscribe(listener: (next: DevicesFile, origin: 'local' | 'external') => void): () => void
}

function normalize(parsed: unknown): DevicesFile {
  const devices = (parsed as { devices?: unknown } | null)?.devices
  if (!Array.isArray(devices)) return { devices: [] }
  return {
    devices: devices.filter(
      (d): d is DeviceRecord =>
        !!d &&
        isDeviceKey(d.publicKey) &&
        typeof d.name === 'string' &&
        (d.admittedBy === 'pairing' || d.admittedBy === 'machineUser') &&
        typeof d.addedAt === 'number' &&
        typeof d.lastSeen === 'number',
    ),
  }
}

export function openDevicesFile(dataDir: string): JsonStateFile<DevicesFile> {
  return createJsonStateFile<DevicesFile>({
    file: dataPaths(dataDir).devices,
    defaults: { devices: [] },
    normalize,
    mode: 0o600,
  })
}
