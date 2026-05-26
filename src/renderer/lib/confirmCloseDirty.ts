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

  const filePath = dirty.length === 1 ? dirty[0].filePath : undefined

  const choice = await window.electronAPI.confirmUnsavedChanges({
    fileName,
    multiple: dirty.length > 1,
    filePath,
  })
  if (choice === 'cancel') return false
  if (choice === 'save') {
    for (const p of dirty) {
      let result: Awaited<ReturnType<typeof saveEditor>> = 'no-handler'
      try { result = await saveEditor(p.id) } catch { /* treat as no-handler */ }
      // Only an explicit Save-As cancellation aborts the close. `no-handler`
      // means the panel isn't currently mounted (e.g. an inactive tab in a
      // dock stack) — we can't save it from here, but aborting would leave
      // the user with no way to proceed. Pre-existing limitation: that
      // tab's content is lost if the user picks "Save".
      if (result === 'cancelled') return false
    }
  }
  return true
}
