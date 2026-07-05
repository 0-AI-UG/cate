// =============================================================================
// Extension manifest loading — read + validate a manifest.json from an
// extension root dir. The shape authority is `normalizeManifest` in
// ../../shared/extensions; this module only handles the disk read and JSON
// parse, degrading to null (never throwing) on any failure.
// =============================================================================

import fs from 'fs/promises'
import path from 'path'
import log from '../logger'
import { normalizeManifest, type ExtensionManifest } from '../../shared/extensions'

const MANIFEST_FILENAME = 'manifest.json'

/**
 * Load and validate `<dir>/manifest.json`. Returns a normalized manifest, or
 * null if the file is missing, unreadable, not valid JSON, or fails validation.
 * Never throws.
 */
export async function loadManifestFromDir(dir: string): Promise<ExtensionManifest | null> {
  const manifestPath = path.join(dir, MANIFEST_FILENAME)
  let raw: string
  try {
    raw = await fs.readFile(manifestPath, 'utf-8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    log.warn('[extensions] %s is not valid JSON', manifestPath)
    return null
  }
  const manifest = normalizeManifest(parsed)
  if (!manifest) {
    log.warn('[extensions] %s failed manifest validation', manifestPath)
  }
  return manifest
}
