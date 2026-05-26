// =============================================================================
// editorSaveRegistry — module-level map of panelId -> save() function.
// EditorPanel registers itself on mount; CanvasNode invokes the save fn when
// the user chooses "Save" in the unsaved-changes dialog.
// =============================================================================

/** Internal save function — true on successful write, false when the user
 *  cancelled the Save-As picker (or the write failed). */
type SaveFn = () => Promise<boolean>

/** Result of {@link saveEditor}:
 *  - `saved`        — write completed
 *  - `cancelled`    — the user dismissed the Save-As picker for an untitled
 *                     buffer (the only case where close-confirm should abort)
 *  - `no-handler`   — no editor is registered for this panel (e.g. dirty
 *                     inactive tab in a dock stack that isn't mounted). The
 *                     caller cannot recover the buffer from here, so it must
 *                     decide whether to proceed without saving or surface
 *                     the situation; aborting the close would strand the
 *                     user without a path forward.
 */
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
  if (!fn) return 'no-handler'
  const ok = await fn()
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
