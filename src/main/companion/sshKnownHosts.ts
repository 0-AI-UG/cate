// =============================================================================
// SSH known-hosts pin — trust-on-first-use (TOFU) host-key verification for
// companion server connections. ssh2 performs NO host-key checking unless given
// a `hostVerifier`; without this a network MITM can impersonate the server the
// daemon (and the pi agent, terminals, git) run against. We pin the host key
// fingerprint on first connect, keyed by host:port, and reject a later mismatch.
//
// Mirrors the sshSecretStore on-disk pattern (userData JSON, atomic temp+rename,
// 0600). Fingerprints are NOT secret — they're public host-key hashes — so they
// are stored in plaintext (unlike the encrypted passphrase store).
// =============================================================================

import { app } from 'electron'
import fsp from 'fs/promises'
import path from 'path'
import log from '../logger'

export type HostKeyVerdict = 'trust-on-first-use' | 'match' | 'mismatch'

/**
 * Pure decision for one host-key presentation. No I/O — the caller persists on
 * `trust-on-first-use` and rejects on `mismatch`. Kept separate so the TOFU
 * policy is unit-testable without electron / the filesystem.
 */
export function evaluateHostKey(pinned: string | null | undefined, presented: string): HostKeyVerdict {
  if (!pinned) return 'trust-on-first-use'
  return pinned === presented ? 'match' : 'mismatch'
}

/** Stable store key for a host. The key belongs to the HOST, not the workspace,
 *  so all companions on the same host:port share one pin and a key change is
 *  caught for every one of them. */
export function hostKeyId(host: string, port?: number): string {
  return `${host}:${port ?? 22}`
}

type OnDisk = Record<string, string>

function knownHostsPath(): string {
  return path.join(app.getPath('userData'), 'companion-known-hosts.json')
}

async function readRaw(): Promise<OnDisk> {
  try {
    const raw = await fsp.readFile(knownHostsPath(), 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as OnDisk
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log.warn('[sshKnownHosts] read failed: %O', err)
    }
  }
  return {}
}

async function writeRaw(data: OnDisk): Promise<void> {
  const p = knownHostsPath()
  await fsp.mkdir(path.dirname(p), { recursive: true, mode: 0o700 })
  const tmp = p + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  try { await fsp.chmod(tmp, 0o600) } catch { /* platforms without modes */ }
  await fsp.rename(tmp, p)
}

export async function getPinnedHostKey(id: string): Promise<string | null> {
  const data = await readRaw()
  return data[id] ?? null
}

export async function pinHostKey(id: string, fingerprint: string): Promise<void> {
  const data = await readRaw()
  data[id] = fingerprint
  await writeRaw(data)
}

export async function removePinnedHostKey(id: string): Promise<void> {
  const data = await readRaw()
  if (id in data) {
    delete data[id]
    await writeRaw(data)
  }
}

/**
 * The verifier the SSH transport hands to ssh2. Accepts a first-seen key (pinning
 * it) and an exact match; throws a clear, actionable error on a mismatch so the
 * connection is refused rather than silently trusting a possibly-hostile key.
 */
export async function verifyAndPinHostKey(id: string, fingerprint: string): Promise<void> {
  const pinned = await getPinnedHostKey(id)
  const verdict = evaluateHostKey(pinned, fingerprint)
  if (verdict === 'mismatch') {
    throw new Error(
      `Host key verification failed for ${id}: the server's SSH key has changed since you ` +
        `first connected (expected ${pinned}, got ${fingerprint}). This can mean the server was ` +
        `legitimately rebuilt, or that the connection is being intercepted. If you trust the ` +
        `change, delete the companion and reconnect to accept the new key.`,
    )
  }
  if (verdict === 'trust-on-first-use') {
    await pinHostKey(id, fingerprint)
    log.info('[sshKnownHosts] pinned host key for %s on first use', id)
  }
}
