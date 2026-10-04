// push.json: the devices registered for pushes from this workspace, one
// target per device, with the key their notifications are sealed with.

import { createJsonStateFile, type JsonStateFile } from '@kernel/state/node'
import { dataPaths } from '@runtime/data/runtime'
import { isPushTarget } from '../contract'

export interface PushTarget {
  /** The device's key fingerprint, as its connections announce it. */
  device: string
  /** Where its push service delivers; opaque here. */
  target: string
  /** 32 bytes, base64. */
  key: string
  registeredAt: number
}

export interface PushFile {
  targets: PushTarget[]
}

export interface PushStore {
  get(): PushFile
  update(fn: (current: PushFile) => PushFile): void
}

function normalize(parsed: unknown): PushFile {
  const targets = (parsed as { targets?: unknown } | null)?.targets
  if (!Array.isArray(targets)) return { targets: [] }
  return {
    targets: targets.filter(
      (t): t is PushTarget =>
        !!t &&
        typeof t.device === 'string' &&
        isPushTarget(t.target) &&
        typeof t.key === 'string' &&
        typeof t.registeredAt === 'number',
    ),
  }
}

export function openPushFile(dataDir: string): JsonStateFile<PushFile> {
  return createJsonStateFile<PushFile>({
    file: dataPaths(dataDir).push,
    defaults: { targets: [] },
    normalize,
    mode: 0o600,
  })
}
