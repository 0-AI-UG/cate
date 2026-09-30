// The contexts workspace UI reads from the client (it may not import the
// client layer): the repository host for the shown workspace and the file
// views host.

import { useMemo, type ReactNode } from 'react'
import { isRpcError } from '@kernel/rpc/contract'
import { tryRuntimeFor } from '@kernel/rpc/client'
import { clientUi } from '@kernel/ui'
import { isIconName } from '@kernel/ui/contract'
import { documentStoreFor } from '@client/document'
import { useDocument } from '@client/document/ui'
import { confirmClose, createPanel, focusedPanelId, panelDefinition, panelDefinitions } from '@client/host'
import { activeCanvasId, createPanelOnCanvas, useCanvasUi } from '@client/layout/canvas'
import { useWorkspaceRoot } from '@client/connections/ui'
import { panelsBoundTo } from '@workspace/repository/contract'
import { RepositoryUiProvider, type RepositoryUiHost, type WorktreeLaunchType } from '@workspace/repository/ui'
import { FileViewsContext } from '@workspace/files/ui'
import type { PanelRecord, WorktreeMeta } from '@workspace/document/contract'
import { openReviewPanel } from '@panels/review/view'
import { fileViewsHost } from './fileActions'

const sameList = <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => x === b[i])
const selectWorktrees = (doc: { worktrees: Record<string, WorktreeMeta> }) => Object.values(doc.worktrees)
const selectPanels = (doc: { panels: Record<string, PanelRecord> }) => Object.values(doc.panels)

/** Types bound to a worktree, in split-menu order. */
function worktreeLaunchTypes(): WorktreeLaunchType[] {
  return panelDefinitions()
    .filter((d) => d.worktreeBinding)
    .sort((a, b) => (a.splitMenuOrder ?? Infinity) - (b.splitMenuOrder ?? Infinity))
    .map((d) => ({ type: d.type, label: d.label, icon: isIconName(d.icon) ? d.icon : 'grid' }))
}

/** A type with `worktreeBinding` switches through its session (which may
 *  refuse with `dirty` while something runs); others just rebind the record. */
async function switchPanelWorktree(workspaceId: string, panelId: string, worktreeId: string): Promise<void> {
  const record = documentStoreFor(workspaceId)?.getSnapshot().panels[panelId]
  const runtime = tryRuntimeFor(workspaceId)
  if (!record || !runtime) return
  if (!panelDefinition(record.type)?.worktreeBinding) {
    documentStoreFor(workspaceId)?.propose({ kind: 'updatePanel', id: panelId, patch: { worktreeId } })
    return
  }
  const send = (discard: boolean) => runtime.session.op({ panelId, op: { kind: 'switchWorktree', worktreeId, ...(discard ? { discard } : {}) } })
  try {
    await send(false)
  } catch (err) {
    if (!isRpcError(err, 'dirty')) throw err
    if (await clientUi().confirm(`${err.message}. Stop it and switch the worktree?`)) await send(true)
  }
}

export function RepositoryHost({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const root = useWorkspaceRoot(workspaceId)
  const worktrees = useDocument(workspaceId, selectWorktrees, sameList)
  const panels = useDocument(workspaceId, selectPanels, sameList)
  const focusedWorktreeId = useCanvasUi((s) => s.focusedWorktreeId)

  const host = useMemo<RepositoryUiHost>(() => ({
    workspaceId,
    root,
    worktrees,
    panels,
    launchTypes: worktreeLaunchTypes(),
    focusedWorktreeId,
    setWorktree(meta) {
      documentStoreFor(workspaceId)?.propose({ kind: 'setWorktree', worktree: meta })
    },
    async launchInWorktree(worktree, type, opts) {
      const options = { worktreeId: worktree.id, cwd: worktree.path }
      const doc = documentStoreFor(workspaceId)?.getSnapshot()
      const canvasId = opts?.canvasPanelId ? doc?.panels[opts.canvasPanelId]?.canvasId : activeCanvasId(workspaceId)
      if (canvasId) return createPanelOnCanvas(workspaceId, canvasId, type, options) !== null
      return createPanel(workspaceId, type, { ...options, near: focusedPanelId(workspaceId) ?? undefined }) !== null
    },
    worktreePanelSummary(worktreeId) {
      const doc = documentStoreFor(workspaceId)?.getSnapshot()
      return { count: doc ? panelsBoundTo(doc, worktreeId).length : 0, hasDirtyEditor: false }
    },
    async prepareWorktreeClose(worktreeId) {
      const doc = documentStoreFor(workspaceId)?.getSnapshot()
      if (!doc) return false
      return confirmClose(workspaceId, panelsBoundTo(doc, worktreeId).map((p) => p.id))
    },
    bindsWorktree: (panel) => panelDefinition(panel.type)?.worktreeBinding === true,
    switchPanelWorktree: (panelId, worktreeId) => switchPanelWorktree(workspaceId, panelId, worktreeId),
    async openReview(request) {
      await openReviewPanel({ workspaceId, ...request })
    },
    focusWorktree: (worktreeId) => useCanvasUi.getState().setFocusedWorktree(worktreeId),
    setHoveredWorktree: (worktreeId) => useCanvasUi.getState().setHoveredWorktree(worktreeId),
  }), [workspaceId, root, worktrees, panels, focusedWorktreeId])

  return <RepositoryUiProvider host={host}>{children}</RepositoryUiProvider>
}

export function FileViewsHost({ children }: { children: ReactNode }) {
  return <FileViewsContext.Provider value={fileViewsHost}>{children}</FileViewsContext.Provider>
}
