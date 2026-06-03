// =============================================================================
// SSH secret store — passphrases for companion server connections, encrypted at
// rest via Electron safeStorage and keyed by companionId. Mirrors the
// authManager pattern (userData JSON, atomic temp+rename, 0600). Key file PATHS
// are not secret and stored in plaintext; only the passphrase is encrypted.
// =============================================================================

import { app, safeStorage } from 'electron'
import fsp from 'fs/promises'
import path from 'path'
import log from '../logger'

export interface SshSecret {
  passphrase?: string
  keyPath?: string
  useAgent?: boolean
}

type OnDisk = Record<string, { passphrase?: string; keyPath?: string; useAgent?: boolean }>

function secretsPath(): string {
  return path.join(app.getPath('userData'), 'companion-ssh-secrets.json')
}

async function readRaw(): Promise<OnDisk> {
  try {
    const raw = await fsp.readFile(secretsPath(), 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as OnDisk
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log.warn('[sshSecretStore] read failed: %O', err)
    }
  }
  return {}
}

async function writeRaw(data: OnDisk): Promise<void> {
  const p = secretsPath()
  await fsp.mkdir(path.dirname(p), { recursive: true, mode: 0o700 })
  const tmp = p + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  try { await fsp.chmod(tmp, 0o600) } catch { /* platforms without modes */ }
  await fsp.rename(tmp, p)
}

export async function saveSshSecret(companionId: string, secret: SshSecret): Promise<void> {
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
  data[companionId] = entry
  await writeRaw(data)
}

export async function getSshSecret(companionId: string): Promise<SshSecret | null> {
  const data = await readRaw()
  const entry = data[companionId]
  if (!entry) return null
  const out: SshSecret = { keyPath: entry.keyPath, useAgent: entry.useAgent }
  if (entry.passphrase) {
    try {
      out.passphrase = safeStorage.decryptString(Buffer.from(entry.passphrase, 'base64'))
    } catch (err) {
      log.warn('[sshSecretStore] failed to decrypt passphrase for %s: %O', companionId, err)
    }
  }
  return out
}

export async function deleteSshSecret(companionId: string): Promise<void> {
  const data = await readRaw()
  if (companionId in data) {
    delete data[companionId]
    await writeRaw(data)
  }
}
