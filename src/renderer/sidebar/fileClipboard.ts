// Shared file-explorer clipboard (Copy / Paste).
// Module-level singleton — only one clipboard across all FileTreeNode instances.

let clipboardPaths: string[] = []

export function setClipboard(paths: string[]): void {
  clipboardPaths = [...paths]
}

export function getClipboard(): string[] {
  return clipboardPaths
}

export function hasClipboard(): boolean {
  return clipboardPaths.length > 0
}
