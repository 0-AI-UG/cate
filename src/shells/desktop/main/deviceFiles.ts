// Device files under Electron's userData (architecture 16), all written by
// main through kernel/state. The shared documents back the renderer's
// DeviceStore; the private ones (device key, install id, updater and
// analytics state) never leave main.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createLogger } from '@kernel/log/contract'
import { createJsonStateFile, readTextFile, writeJsonAtomicSync, writeTextFile, type JsonStateFile } from '@kernel/state/node'
import { decodeKeyPair, encodeKeyPair, fingerprint, generateKeyPair, type KeyPair } from '@runtime/security/contract'
import {
  MAIN_OWNED_BOOT_FIELDS,
  PRIVATE_DEVICE_FILES,
  SHARED_DEVICE_DOCUMENTS,
  type BootSnapshot,
  type SharedDeviceDocument,
} from '../contract'

const log = createLogger('device')

/** Who changed a document: this main process, a renderer (by webContents id),
 *  or a hand edit of the file. */
type DeviceChangeOrigin = { kind: 'main' } | { kind: 'renderer'; id: number } | { kind: 'external' }

export interface DeviceFiles {
  readonly dir: string
  /** The document, or undefined when it does not exist yet. */
  get(name: SharedDeviceDocument): unknown
  set(name: SharedDeviceDocument, value: unknown, origin?: DeviceChangeOrigin): void
  subscribe(listener: (name: SharedDeviceDocument, value: unknown, origin: DeviceChangeOrigin) => void): () => void
  boot(): BootSnapshot
  /** Merges main-owned boot fields (window bounds, theme cache). */
  updateBoot(patch: Partial<BootSnapshot>): void
  /** This device's static key pair, created (0600) on first launch. */
  deviceKeys(): KeyPair
  deviceFingerprint(): string
  installId(): string
  /** Whether a valid install id existed before this launch first read it. */
  installIdPreexisted(): boolean
  flushSync(): void
  dispose(): void
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function createDeviceFiles(dir: string): DeviceFiles {
  const files = new Map<SharedDeviceDocument, JsonStateFile<Record<string, unknown> | null>>()
  const listeners = new Set<(name: SharedDeviceDocument, value: unknown, origin: DeviceChangeOrigin) => void>()
  // A local set is announced with its origin; the file store echoes it as
  // 'local', which is skipped here.
  const emit = (name: SharedDeviceDocument, value: unknown, origin: DeviceChangeOrigin) => {
    for (const listener of [...listeners]) {
      try { listener(name, value, origin) } catch (error) { log.warn('device listener failed: %O', error) }
    }
  }

  for (const name of SHARED_DEVICE_DOCUMENTS) {
    const file = createJsonStateFile<Record<string, unknown> | null>({
      file: path.join(dir, `${name}.json`),
      defaults: null,
      normalize: (parsed) => (isPlainObject(parsed) ? parsed : null),
    })
    files.set(name, file)
  }
  let watching: (() => void)[] | null = null
  const watch = () => {
    if (watching) return
    watching = [...files].map(([name, file]) => file.subscribe((value, origin) => {
      if (origin === 'external') emit(name, value ?? undefined, { kind: 'external' })
    }))
  }

  const fileOf = (name: SharedDeviceDocument) => files.get(name)!

  let keys: KeyPair | null = null
  let installId: string | null = null
  let installIdExisted: boolean | null = null

  const self: DeviceFiles = {
    dir,
    get: (name) => fileOf(name).get() ?? undefined,
    set(name, value, origin = { kind: 'main' }) {
      let next = isPlainObject(value) ? value : null
      if (name === 'boot' && origin.kind !== 'main') {
        // The renderer writes only its own boot fields.
        const current = fileOf('boot').get() ?? {}
        next = { ...(next ?? {}) }
        for (const key of MAIN_OWNED_BOOT_FIELDS) {
          if (key in current) next[key] = current[key]
          else delete next[key]
        }
      }
      fileOf(name).set(next)
      emit(name, next ?? undefined, origin)
    },
    subscribe(listener) {
      watch()
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    boot: () => (fileOf('boot').get() ?? {}) as BootSnapshot,
    updateBoot(patch) {
      const current = fileOf('boot').get() ?? {}
      self.set('boot', { ...current, ...patch }, { kind: 'main' })
    },
    deviceKeys() {
      if (keys) return keys
      const file = path.join(dir, PRIVATE_DEVICE_FILES.deviceKey)
      const raw = readTextFile(file)
      let stored: KeyPair | null = null
      if (raw !== null) {
        try { stored = decodeKeyPair(JSON.parse(raw)) } catch { stored = null }
        if (!stored) log.error('%s is not a valid key pair; creating a new device key (paired workspaces must pair again)', file)
      }
      if (!stored) {
        stored = generateKeyPair()
        writeJsonAtomicSync(file, encodeKeyPair(stored), { mode: 0o600 })
      } else {
        try { fs.chmodSync(file, 0o600) } catch { /* best effort */ }
      }
      keys = stored
      return keys
    },
    deviceFingerprint: () => fingerprint(self.deviceKeys().publicKey),
    installId() {
      if (installId) return installId
      const file = path.join(dir, PRIVATE_DEVICE_FILES.installId)
      const raw = readTextFile(file)?.trim()
      const valid = !!raw && /^[0-9a-f-]{36}$/i.test(raw)
      if (installIdExisted === null) installIdExisted = valid
      if (valid) return (installId = raw!)
      installId = crypto.randomUUID()
      writeTextFile(file, installId)
      return installId
    },
    installIdPreexisted() {
      self.installId()
      return installIdExisted === true
    },
    flushSync() {
      for (const file of files.values()) {
        try { file.flushSync() } catch (error) { log.warn('flush of %s failed: %O', file.path, error) }
      }
    },
    dispose() {
      for (const off of watching ?? []) off()
      watching = null
      for (const file of files.values()) file.dispose()
      listeners.clear()
    },
  }
  return self
}
