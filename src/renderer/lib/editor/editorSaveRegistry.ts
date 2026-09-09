import { saveEditorDocument } from './editorDocuments'
// =============================================================================
// editorSaveRegistry — module-level map of panelId -> save() function.
// EditorPanel registers itself on mount; CanvasNode invokes the save fn when
// the user chooses "Save" in the unsaved-changes dialog.
// =============================================================================

/** Internal save function — true on successful write, false when the user
 *  cancelled the Save-As picker (or the write failed). */
type SaveFn = () => Promise<boolean>

/** Close is safe only after an explicit successful save. Unmounted views use
 * the document owner; no-handler means no recoverable document exists. */
export type SaveResult = 'saved' | 'cancelled' | 'no-handler'

const registry = new Map<string, SaveFn>()

export function registerEditorSave(panelId: string, fn: SaveFn): void {
  registry.set(panelId, fn)
}

export function unregisterEditorSave(panelId: string): void {
  registry.delete(panelId)
}

export async function saveEditor(panelId: string): Promise<SaveResult> {
  const fn = registry.get(panelId)
  const pending = fn ? fn() : saveEditorDocument(panelId)
  if (!pending) return 'no-handler'
  const ok = await pending
  return ok ? 'saved' : 'cancelled'
}

// Tracks which editor most recently held keyboard focus on its Monaco
// textarea. The window-level Cmd+S / Ctrl+S `save-file` event routes to
// THIS panel, not whichever editor happens to hold `hasTextFocus()` at the
// instant the key fires — so clicking the markdown preview toggle or any
// other panel chrome doesn't leave the user without a save target.
let activeEditorPanelId: string | null = null

export function markEditorActive(panelId: string): void {
  activeEditorPanelId = panelId
}

export function clearEditorActive(panelId: string): void {
  if (activeEditorPanelId === panelId) activeEditorPanelId = null
}

export function getActiveEditorPanelId(): string | null {
  return activeEditorPanelId
}
