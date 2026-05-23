// =============================================================================
// canvasSyncGuard — pure decision: should `syncCanvasToWorkspace` write the
// live canvas store back to the workspace, or keep the persisted snapshot?
//
// The workspace's primary canvas panel can be detached into a different
// window. In the source window the per-panel registry then hands out a fresh
// empty CanvasOperations for that panelId, and a naive write would overwrite
// the user's saved children with `{}`. The guard preserves the existing
// snapshot when the incoming store is empty but the saved one isn't.
// =============================================================================

export function shouldPreserveExistingCanvas(
  incomingNodeCount: number,
  existingNodeCount: number,
): boolean {
  return incomingNodeCount === 0 && existingNodeCount > 0
}
