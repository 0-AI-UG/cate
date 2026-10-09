// The trust hash codex keeps for a hook it trusts, for the live suites that
// plant trust in a scratch profile.

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'

/** sha256 of codex's canonical handler identity — the recipe codex checks a
 *  hooks.state trusted_hash against, verified live. Product code does not plant
 *  trust (the user grants it once in codex's own review prompt); the builder
 *  stays exported for the pinned-vector test. */
export function codexTrustedHash(label: string, command: string, timeout: number): string {
  const identity =
    `{"event_name":${JSON.stringify(label)},"hooks":[{"async":false,` +
    `"command":${JSON.stringify(command)},"timeout":${timeout},"type":"command"}]}`
  return 'sha256:' + bytesToHex(sha256(utf8ToBytes(identity)))
}
