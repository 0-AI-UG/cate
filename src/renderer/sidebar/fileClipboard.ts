// Shared file-explorer clipboard (Copy / Paste).
// Module-level singleton — only one clipboard across all FileTreeNode instances.

let clipboardPaths: string[] = []
const listeners = new Set<() => void>()

export function setClipboard(paths: string[]): void {
  clipboardPaths = [...paths]
  for (const fn of listeners) fn()
}

export function getClipboard(): string[] {
  return clipboardPaths
}

export function hasClipboard(): boolean {
  return clipboardPaths.length > 0
}

export function subscribeClipboard(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
