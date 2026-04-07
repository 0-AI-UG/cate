// =============================================================================
// confirmCloseDirty — shared helper that prompts the user via the native
// unsaved-changes dialog when closing editor panels with pending changes.
// Returns true if the close should proceed.
// =============================================================================

import type { PanelState } from '../../shared/types'
import { saveEditor } from './editorSaveRegistry'

export async function confirmCloseDirtyPanels(
  panels: Array<PanelState | undefined>,
): Promise<boolean> {
  const dirty = panels.filter(
    (p): p is PanelState => !!p && p.type === 'editor' && !!p.isDirty,
  )
  if (dirty.length === 0) return true
  if (!window.electronAPI?.confirmUnsavedChanges) return true

  const fileName =
    dirty.length === 1
      ? dirty[0].title.replace(/\s•\s*$/, '').trim()
      : `${dirty.length} files`

  const choice = await window.electronAPI.confirmUnsavedChanges({
    fileName,
    multiple: dirty.length > 1,
  })
  if (choice === 'cancel') return false
  if (choice === 'save') {
    for (const p of dirty) {
      try { await saveEditor(p.id) } catch { /* swallow — user can retry */ }
    }
  }
  return true
}
