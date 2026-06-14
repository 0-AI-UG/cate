// =============================================================================
// Install ID — random, anonymous identifier persisted in userData. Used to
// roughly deduplicate event volume per install. No PII derivation: it is not
// hashed from hardware, hostname, or anything user-attributable.
// =============================================================================

import crypto from 'crypto'
import { readTextFile, writeTextFile } from './jsonFileStore'

const FILENAME = 'install-id'
let cached: string | null = null
// Captured on the very first getInstallId() call (which is the only writer of
// the file): was a valid id already on disk? Since the file is written only
// from inside the telemetry send path, a pre-existing id means this install has
// sent telemetry before. A missing id on an install that has clearly run before
// (see analytics census) marks a previously-silent install worth backfilling.
let preexisted: boolean | null = null

export function getInstallId(): string {
  if (cached) return cached
  const raw = readTextFile(FILENAME)?.trim()
  const valid = !!(raw && /^[0-9a-f-]{36}$/i.test(raw))
  if (preexisted === null) preexisted = valid
  if (valid) {
    cached = raw!
    return cached
  }
  const id = crypto.randomUUID()
  writeTextFile(FILENAME, id)
  cached = id
  return id
}

/** Whether a valid install-id file already existed the first time the id was
 *  read this session — i.e. this install has sent telemetry under a prior
 *  (opt-in) build. Forces a read so the answer is well-defined even if nothing
 *  else has touched the id yet. */
export function installIdPreexisted(): boolean {
  getInstallId()
  return preexisted === true
}
