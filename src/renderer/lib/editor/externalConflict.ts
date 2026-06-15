// =============================================================================
// externalConflict — pure routing for filesystem events that hit a file open in
// an EditorPanel.
//
// An external mutation (another editor, a git checkout, an AI agent) reaches the
// open buffer through the workspace-root fs watcher. How we react depends on
// whether the user has unsaved edits:
//   - clean buffer + change  → reload the model from disk (silent, live update)
//   - dirty buffer + change  → raise a conflict so the user's edits aren't
//                              clobbered and the agent's change isn't lost
//   - delete (any state)     → raise a deletion conflict; saving re-creates the
//                              file, closing discards it for good
// =============================================================================

export type ExternalEventType = 'create' | 'update' | 'delete'

/** What the EditorPanel should do with an external fs event for its file. */
export type ExternalAction = 'reload' | 'conflict-changed' | 'conflict-deleted'

/**
 * Decide how to react to an external filesystem event on the open file.
 *
 * `isDirty` is whether the editor buffer has unsaved user edits.
 */
export function classifyExternalEvent(
  eventType: ExternalEventType,
  isDirty: boolean,
): ExternalAction {
  if (eventType === 'delete') return 'conflict-deleted'
  return isDirty ? 'conflict-changed' : 'reload'
}

/**
 * Save-time guard (does not depend on the fs watcher): decide whether writing
 * the buffer would silently clobber an external change.
 *
 * - `baseline`  — disk content we last synced with (load or previous save); null
 *                 means no known baseline (untitled / unloaded) → never block.
 * - `diskNow`   — content read from disk right before writing; null means the
 *                 read failed (file deleted/unreadable) → don't block, let the
 *                 write proceed (e.g. a Save-to-restore re-creates the file).
 * - `buffer`    — what we're about to write.
 *
 * Block only when the file changed on disk since we loaded it AND that on-disk
 * version differs from our buffer (if it already equals the buffer, there's
 * nothing to lose by writing).
 */
export function shouldBlockOverwrite(
  baseline: string | null,
  diskNow: string | null,
  buffer: string,
): boolean {
  if (baseline === null || diskNow === null) return false
  return diskNow !== baseline && diskNow !== buffer
}
