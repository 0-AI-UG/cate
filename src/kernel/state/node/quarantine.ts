import fs from 'node:fs'

/** Copy an unparseable state file aside as `<file>.corrupt-<ts>` so a broken
 *  hand edit or crash mid-write stays recoverable. Returns the backup path, or
 *  null when the copy failed. Never throws. */
export function quarantineCorruptFile(file: string): string | null {
  try {
    const backup = `${file}.corrupt-${Date.now()}`
    fs.copyFileSync(file, backup)
    return backup
  } catch {
    return null
  }
}
