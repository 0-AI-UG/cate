import fs from 'node:fs'

export interface Quarantined {
  file: string
  backup: string
}

const quarantined: Quarantined[] = []
const listeners = new Set<(entry: Quarantined) => void>()

/** Copy an unparseable state file aside as `<file>.corrupt-<ts>` so a broken
 *  hand edit or crash mid-write stays recoverable. Returns the backup path, or
 *  null when the copy failed. Never throws. The process's owner learns of it
 *  (`quarantinedFiles`, `onQuarantine`) and warns the person. */
export function quarantineCorruptFile(file: string): string | null {
  let backup: string
  try {
    backup = `${file}.corrupt-${Date.now()}`
    fs.copyFileSync(file, backup)
  } catch {
    return null
  }
  const entry = { file, backup }
  quarantined.push(entry)
  for (const listener of [...listeners]) {
    try { listener(entry) } catch { /* a listener must not break loading */ }
  }
  return backup
}

/** The files this process quarantined so far. */
export function quarantinedFiles(): readonly Quarantined[] {
  return quarantined
}

export function onQuarantine(listener: (entry: Quarantined) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
