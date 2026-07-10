// Main-owned persistence for file paths explicitly approved by native dialogs.
// The canonical JSON state engine owns parsing, quarantine, in-memory authority,
// atomic writes, and write serialization; this module only enforces the grant
// list's string-array schema.

import { createJsonStateFile } from './jsonStateFile'

const grants = createJsonStateFile<string[]>({
  filename: 'granted-paths.json',
  defaults: [],
  normalize: (parsed) => Array.isArray(parsed)
    ? [...new Set(parsed.filter((value): value is string => typeof value === 'string'))]
    : [],
})

/** Persist before resolving so an immediate quit after Save As cannot lose the grant. */
export async function recordPersistentGrant(filePath: string): Promise<void> {
  const current = grants.get()
  if (current.includes(filePath)) return
  grants.set([...current, filePath])
  grants.flushPendingWritesSync()
}

export async function listPersistentGrants(): Promise<string[]> {
  return [...grants.get()]
}
