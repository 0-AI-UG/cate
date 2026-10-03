// Closing an editor from generic UI (a tab's close button, Cmd+W, a canvas
// taking its panels) asks about unsaved edits first (architecture 11.2 rule
// 6). The session decides whether they would be lost: another editor showing
// the same buffer keeps them.

import { isRpcError } from '@kernel/rpc/contract'
import type { CloseGuard } from '@client/host'
import type { EditorOp, EditorSnapshot } from '@panels/editor/contract'
import { confirmUnsaved } from './editorActions'

export const editorCloseGuard: CloseGuard = async ({ workspaceId, record, session }) => {
  if (!session) return true
  const send = (op: EditorOp) => session.send(op)
  try {
    await send({ kind: 'prepareClose' })
    return true
  } catch (err) {
    if (!isRpcError(err, 'dirty')) throw err
  }
  // The session's snapshot says whether the file is a draft; before it
  // arrives, the record's path is saved in place.
  const filePath = typeof record.fields.filePath === 'string' ? record.fields.filePath : ''
  const snapshot = (session.getSnapshot() as { snapshot: EditorSnapshot } | null)?.snapshot
  const file = snapshot ?? { filePath, draft: false, checkout: null }
  const answer = await confirmUnsaved(send, workspaceId, { ...file, dirty: true }, record.title)
  if (!answer) return false
  if (answer === 'discard') await send({ kind: 'prepareClose', discard: true })
  return true
}
