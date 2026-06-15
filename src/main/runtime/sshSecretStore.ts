// =============================================================================
// SSH secret store — passphrases for runtime server connections, encrypted at
// rest via Electron safeStorage and keyed by runtimeId. Mirrors the
// authManager pattern (userData JSON, atomic temp+rename, 0600). Key file PATHS
// are not secret and stored in plaintext; only the passphrase is encrypted.
// =============================================================================

import { app, safeStorage } from 'electron'
import fsp from 'fs/promises'
import path from 'path'
import log from '../logger'
import { writeJsonAtomic } from '../writeJsonAtomic'
import { isPlainObject } from '../jsonUtils'

export interface SshSecret {
  passphrase?: string
  keyPath?: string
  useAgent?: boolean
}

type OnDisk = Record<string, { passphrase?: string; keyPath?: string; useAgent?: boolean }>

function secretsPath(): string {
  return path.join(app.getPath('userData'), 'runtime-ssh-secrets.json')
}

async function readRaw(): Promise<OnDisk> {
  try {
    const raw = await fsp.readFile(secretsPath(), 'utf-8')
    const parsed = JSON.parse(raw)
    if (isPlainObject(parsed)) return parsed as OnDisk
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log.warn('[sshSecretStore] read failed: %O', err)
    }
  }
  return {}
}

async function writeRaw(data: OnDisk): Promise<void> {
  await writeJsonAtomic(secretsPath(), data, { mode: 0o600 })
}

export async function saveSshSecret(runtimeId: string, secret: SshSecret): Promise<void> {
  const data = await readRaw()
  const entry: OnDisk[string] = {}
  if (secret.passphrase) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS secure storage is unavailable; cannot save SSH passphrase')
    }
    entry.passphrase = safeStorage.encryptString(secret.passphrase).toString('base64')
  }
  if (secret.keyPath) entry.keyPath = secret.keyPath
  if (secret.useAgent) entry.useAgent = true
  data[runtimeId] = entry
  await writeRaw(data)
}

export async function getSshSecret(runtimeId: string): Promise<SshSecret | null> {
  const data = await readRaw()
  const entry = data[runtimeId]
  if (!entry) return null
  const out: SshSecret = { keyPath: entry.keyPath, useAgent: entry.useAgent }
  if (entry.passphrase) {
    try {
      out.passphrase = safeStorage.decryptString(Buffer.from(entry.passphrase, 'base64'))
    } catch (err) {
      log.warn('[sshSecretStore] failed to decrypt passphrase for %s: %O', runtimeId, err)
    }
  }
  return out
}

export async function deleteSshSecret(runtimeId: string): Promise<void> {
  const data = await readRaw()
  if (runtimeId in data) {
    delete data[runtimeId]
    await writeRaw(data)
  }
}
