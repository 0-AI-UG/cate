import type { PanelTransferSnapshot } from '../../../shared/types'

/** A destination first accepts a staged handoff. Capture again after readiness:
 * the source stays live while the new renderer loads, so edits made during that
 * wait must be included in the accepted snapshot. */
export async function detachPanel(snapshot: PanelTransferSnapshot, workspaceId: string | undefined, capture: () => PanelTransferSnapshot | null): Promise<number | null> {
  const transferId = crypto.randomUUID()
  const windowId = await window.electronAPI.dragDetach({ ...snapshot, transferId }, workspaceId)
  if (windowId == null) return null
  const latest = capture()
  if (!latest) { await window.electronAPI.commitPanelTransfer(transferId, null); return null }
  if (!await window.electronAPI.commitPanelTransfer(transferId, { ...latest, transferId })) return null
  // No input event may race source teardown after this synchronous final send.
  // Scrollback can advance independently; portable panel content must still match.
  const identity = (value: PanelTransferSnapshot | null) => value && JSON.stringify({
    panel: value.panel, geometry: value.geometry, sourceLocation: value.sourceLocation,
    rootPath: value.rootPath, worktrees: value.worktrees,
    canvas: value.canvasState && { ...value.canvasState, childTerminals: Object.fromEntries(Object.entries(value.canvasState.childTerminals ?? {}).map(([id, terminal]) => [id, terminal.ptyId])) },
    terminalPtyId: value.terminalPtyId,
  })
  const finalSnapshot = capture()
  if (!finalSnapshot || identity(finalSnapshot) !== identity(latest)) {
    await window.electronAPI.commitPanelTransfer(transferId, null)
    return null
  }
  window.electronAPI.finishPanelTransfer(transferId, finalSnapshot)
  return windowId
}
