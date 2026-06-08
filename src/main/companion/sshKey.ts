// =============================================================================
// SSH private-key helpers — path normalization and a friendly format check so a
// failed remote connect explains *why* (a pasted/quoted path, a PuTTY .ppk, or
// an otherwise unparseable key) instead of a generic auth/transport error.
// =============================================================================

import { homedir } from 'os'

/**
 * Normalize a user-entered private-key path. Strips a single pair of surrounding
 * quotes (a natural copy/paste from a path dialog) and expands a leading `~`.
 *
 * Without the quote strip, a pasted `"C:\Users\me\key.pem"` is stored verbatim
 * and the leading `"` makes the OS treat it as a RELATIVE path — so it gets
 * resolved against the app's install dir and fails with a baffling ENOENT
 * pointing at `…\cate\"C:\Users\me\key.pem"`. See issue #335.
 */
export function normalizeKeyPath(raw: string, home: string = homedir()): string {
  let s = raw.trim()
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    s = s.slice(1, -1).trim()
  }
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) {
    s = home + s.slice(1)
  }
  return s
}

async function loadParseKey(): Promise<
  (data: Buffer | string, passphrase?: string) => unknown
> {
  const spec = 'ssh2'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = (await import(spec)) as any
  // ssh2 is CommonJS. `utils` is not a statically-detected named export, so under
  // Node's native ESM↔CJS interop (the packaged app) `mod.utils` is undefined and
  // only `mod.default.utils` is populated. Vite/vitest hoists it, which is why this
  // passed tests but threw "reading 'parseKey'" in the build. See issue #335.
  const utils = mod.utils ?? mod.default?.utils
  return utils.parseKey
}

/**
 * Validate a private-key buffer BEFORE the SSH connect so an unsupported format
 * surfaces as a clear, actionable error rather than a generic auth/host failure.
 * PuTTY `.ppk` is the common culprit and is named explicitly with the puttygen
 * conversion. Encrypted-key / wrong-passphrase parse failures are deliberately
 * NOT treated as format errors — ssh2 may still complete the connect via the SSH
 * agent or a supplied passphrase, so we let the real connect decide. See #333.
 */
export async function assertSupportedPrivateKey(key: Buffer, passphrase?: string): Promise<void> {
  const head = key.subarray(0, 64).toString('utf8').trimStart()
  if (head.startsWith('PuTTY-User-Key-File')) {
    throw new Error(
      "This looks like a PuTTY .ppk key, which isn't supported. Convert it to OpenSSH " +
        'format first, e.g.  puttygen mykey.ppk -O private-openssh -o mykey',
    )
  }
  const parseKey = await loadParseKey()
  const parsed = parseKey(key, passphrase)
  if (!(parsed instanceof Error)) return
  // Encrypted key with a missing/incorrect passphrase: not a format problem —
  // the agent or a passphrase entered later can still satisfy it. Stay quiet.
  if (/passphrase|integrity check/i.test(parsed.message)) return
  throw new Error(
    `Unsupported private key format (${parsed.message}). Supported formats are OpenSSH and ` +
      'PEM (RSA/EC/ED25519/DSA). PuTTY .ppk keys must be converted: ' +
      'puttygen mykey.ppk -O private-openssh -o mykey',
  )
}
