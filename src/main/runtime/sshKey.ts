// =============================================================================
// SSH identity helpers. OpenSSH owns key parsing so certificates, security keys,
// PKCS#11 providers, and future formats work without Cate duplicating its parser.
// Cate only normalizes pasted paths and retains the actionable PuTTY guidance.
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

/** Preserve the existing targeted guidance for the one format OpenSSH does not
 * accept. Every actual OpenSSH/private-key/certificate parse remains delegated
 * to the system client so Cate cannot reject formats it does not understand. */
export function assertNotPuttyKey(key: Buffer): void {
  const head = key.subarray(0, 64).toString('utf8').trimStart()
  if (head.startsWith('PuTTY-User-Key-File')) {
    throw new Error(
      "This looks like a PuTTY .ppk key, which isn't supported. Convert it to OpenSSH " +
        'format first, e.g.  puttygen mykey.ppk -O private-openssh -o mykey',
    )
  }
}
