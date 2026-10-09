// The `known-runtimes` device document: the runtime key pinned per runtimeId
// (the runtime's network id, derived from that key).

import type { DeviceStore } from '@kernel/state/contract'
import { decodePublicKey, encodePublicKey } from '../../security/contract'
import type { RuntimePins } from '../../security/client'

export const KNOWN_RUNTIMES_DOCUMENT = 'known-runtimes'

export interface KnownRuntime {
  /** hex X25519 public key */
  publicKey: string
  pinnedAt: number
}

interface KnownRuntimesFile {
  runtimes: Record<string, KnownRuntime>
}

export class KnownRuntimes implements RuntimePins {
  constructor(
    private readonly store: Pick<DeviceStore, 'get' | 'set'>,
    private readonly now: () => number = Date.now,
  ) {}

  async get(runtimeId: string): Promise<Uint8Array | undefined> {
    const entry = (await this.read()).runtimes[runtimeId]
    if (!entry) return undefined
    try {
      return decodePublicKey(entry.publicKey)
    } catch {
      return undefined
    }
  }

  async list(): Promise<Record<string, KnownRuntime>> {
    return (await this.read()).runtimes
  }

  /** Pins a runtime's key; refuses another key for an id already pinned. */
  async pin(runtimeId: string, publicKey: Uint8Array): Promise<void> {
    const file = await this.read()
    const pinned = file.runtimes[runtimeId]
    if (pinned && pinned.publicKey !== encodePublicKey(publicKey)) {
      throw new Error(`runtime ${runtimeId} is pinned to another key`)
    }
    file.runtimes[runtimeId] = { publicKey: encodePublicKey(publicKey), pinnedAt: this.now() }
    await this.store.set(KNOWN_RUNTIMES_DOCUMENT, file)
  }

  /** "Forget this workspace". */
  async forget(runtimeId: string): Promise<void> {
    const file = await this.read()
    if (!(runtimeId in file.runtimes)) return
    delete file.runtimes[runtimeId]
    await this.store.set(KNOWN_RUNTIMES_DOCUMENT, file)
  }

  private async read(): Promise<KnownRuntimesFile> {
    const value = (await this.store.get(KNOWN_RUNTIMES_DOCUMENT)) as Partial<KnownRuntimesFile> | undefined
    const runtimes: Record<string, KnownRuntime> = {}
    if (value && value.runtimes && typeof value.runtimes === 'object') {
      for (const [id, entry] of Object.entries(value.runtimes)) {
        if (entry && typeof entry.publicKey === 'string' && typeof entry.pinnedAt === 'number') runtimes[id] = entry
      }
    }
    return { runtimes }
  }
}
