// "Copy Path" and "Copy Relative Path" in the tab menu of a file panel, on
// clients that can write the clipboard.

import { tryRuntimeFor } from '@kernel/rpc/client'
import { clientUi } from '@kernel/interaction'
import { documentStoreFor } from '@client/document'
import type { TabMenuContribution } from '../../client/layout/dock'
import { toRelativePath } from '@workspace/files/contract'
import { worktreeForPath } from '@workspace/repository/contract'

const filePathOf = (fields: Record<string, unknown>): string | null =>
  typeof fields.filePath === 'string' && fields.filePath ? fields.filePath : null

/** The checkout the file is in: its worktree, else the workspace root. */
async function checkoutRoot(workspaceId: string, path: string): Promise<string | null> {
  const doc = documentStoreFor(workspaceId)?.getSnapshot()
  const worktree = doc ? worktreeForPath(path, Object.values(doc.worktrees)) : undefined
  if (worktree) return worktree.path
  const info = await tryRuntimeFor(workspaceId)?.workspace.info().catch(() => null)
  return info?.root ?? null
}

export const editorTabMenu: TabMenuContribution = {
  items: ({ record }) => record.type === 'editor' && filePathOf(record.fields)
    ? [{ id: 'copy-path', label: 'Copy Path' }, { id: 'copy-rel-path', label: 'Copy Relative Path' }]
    : [],
  async run(id, { workspaceId, record }) {
    if (id !== 'copy-path' && id !== 'copy-rel-path') return false
    const path = filePathOf(record.fields)
    const write = clientUi().writeClipboard
    if (!path || !write) return true
    const root = id === 'copy-rel-path' ? await checkoutRoot(workspaceId, path) : null
    await write(root ? toRelativePath(path, root) : path)
    return true
  },
}
