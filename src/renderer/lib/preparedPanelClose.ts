import type { PanelCloseOperation } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { confirmClosePanels } from './confirmClosePanels'
import { editorPanelContent } from './editor/editorDocuments'
const prepared = new Map<string, { panelId: string; fingerprint: string; timer: ReturnType<typeof setTimeout> }>()
function fingerprint(workspaceId: string, panelId: string): string {
  const panel = useAppStore.getState().workspaces?.find(w => w.id === workspaceId)?.panels[panelId]
  if (!panel) return 'null'
  // Approved deletion changes dirty/title/recovery flags through the filesystem
  // watcher. Compare actual bytes and resource identity, not that derived UI.
  return JSON.stringify({
    type: panel.type,
    filePath: panel.filePath,
    content: panel.type === 'editor' ? editorPanelContent(panel) : undefined,
    cwd: panel.cwd,
    worktreeId: panel.worktreeId,
    ptyEpoch: panel.ptyEpoch,
    agentThreadId: panel.agentThreadId,
    reviewState: panel.reviewState,
  })
}
function forget(token: string): void {
  const entry = prepared.get(token)
  if (entry) clearTimeout(entry.timer)
  prepared.delete(token)
}
export function rememberPreparedPanelClose(workspaceId: string, panelId: string, token: string): void {
  const key = `${token}:${panelId}`
  forget(key)
  const timer = setTimeout(() => forget(key), 120_000)
  ;(timer as unknown as { unref?: () => void }).unref?.()
  prepared.set(key, { panelId, fingerprint: fingerprint(workspaceId, panelId), timer })
}
/** A preparation never removes a panel. Commits consume the exact approved
 * snapshot; edits after approval preserve the panel for recovery. */
export async function runPreparedPanelClose(workspaceId: string, panelId: string, operation: PanelCloseOperation): Promise<boolean> {
  const key = `${operation.token}:${panelId}`
  if (operation.phase === 'cancel') { forget(key); return true }
  if (operation.phase === 'prepare') {
    if (!(await confirmClosePanels(workspaceId, [panelId]))) return false
    rememberPreparedPanelClose(workspaceId, panelId, operation.token)
    return true
  }
  const entry = prepared.get(key)
  forget(key)
  if (!entry || entry.fingerprint !== fingerprint(workspaceId, panelId)) return false
  useAppStore.getState().closePanel(workspaceId, panelId)
  return true
}
