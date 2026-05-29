// =============================================================================
// editorReveal — one-shot "open this editor at line/column" hand-off.
//
// When a terminal file link is clicked, we createEditor() (which returns a
// panelId synchronously) and stash the desired line here; EditorPanel consumes
// it once after its Monaco model loads, then it's gone — so a later remount of
// the same panel won't re-jump. Kept dependency-free (no Monaco import) so the
// terminal link provider can set reveals without pulling the editor bundle.
// =============================================================================

export interface EditorReveal {
  /** 1-based line to reveal. */
  line: number
  /** 1-based column; defaults to 1 when consumed. */
  column?: number
}

const pending = new Map<string, EditorReveal>()

/** Record where a freshly-created editor panel should jump once it mounts. */
export function setPendingReveal(panelId: string, reveal: EditorReveal): void {
  pending.set(panelId, reveal)
}

/** Consume the pending reveal for a panel (one-shot — cleared on read). */
export function takePendingReveal(panelId: string): EditorReveal | undefined {
  const reveal = pending.get(panelId)
  if (reveal) pending.delete(panelId)
  return reveal
}
