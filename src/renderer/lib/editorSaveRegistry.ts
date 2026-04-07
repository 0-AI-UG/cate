// =============================================================================
// editorSaveRegistry — module-level map of panelId -> save() function.
// EditorPanel registers itself on mount; CanvasNode invokes the save fn when
// the user chooses "Save" in the unsaved-changes dialog.
// =============================================================================

type SaveFn = () => Promise<void>

const registry = new Map<string, SaveFn>()

export function registerEditorSave(panelId: string, fn: SaveFn): void {
  registry.set(panelId, fn)
}

export function unregisterEditorSave(panelId: string): void {
  registry.delete(panelId)
}

export async function saveEditor(panelId: string): Promise<void> {
  const fn = registry.get(panelId)
  if (fn) await fn()
}
