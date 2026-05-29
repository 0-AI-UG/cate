// =============================================================================
// importExternalEntries — handle files/folders dragged into Cate from the OS
// file manager (Finder, Explorer, …). Prompts copy/move and imports them into a
// target workspace directory via the privileged fsImportEntries IPC.
//
// The caller is responsible for the synchronous preventDefault()/stopPropagation()
// inside the drop event handler (so the drop doesn't bubble to the app-root
// handler or make Chromium navigate to the file://). This module only covers
// detection, the dialog, and the import itself.
// =============================================================================

import log from './logger'

/** True when the drag carries OS files (an external drop), not an internal
 *  Cate panel/file drag. */
export function isExternalFileDrag(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes('Files')
}

/**
 * Resolve dropped File objects to absolute OS paths, ask the user whether to
 * copy or move them, and import them into `destDir`. `destName` is the
 * human-readable label shown in the dialog (defaults to the destination's
 * basename). Returns true if any entry was imported.
 */
export async function importDroppedEntries(
  files: FileList,
  destDir: string,
  destName?: string,
): Promise<boolean> {
  const api = window.electronAPI
  if (!api || !destDir) return false

  try {
    const sources = Array.from(files)
      .map((f) => api.getPathForFile(f))
      .filter((p): p is string => !!p)
    if (sources.length === 0) return false

    const label = destName ?? destDir.split('/').filter(Boolean).pop() ?? destDir
    const choice = await api.confirmImportEntries({ count: sources.length, destName: label })
    if (choice === 'cancel') return false

    const result = await api.fsImportEntries(sources, destDir, choice)
    if (result.failed > 0) {
      log.warn(`[file-explorer] ${result.failed} of ${sources.length} item(s) failed to import`)
    }
    return result.created.length > 0
  } catch (err) {
    log.error('[file-explorer] import failed:', err)
    return false
  }
}
