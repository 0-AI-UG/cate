// What the view asks its user before sending an op (architecture 11.2 rule
// 6): where to save, and what to do with unsaved edits. The session never
// asks; it fails `dirty` and the view retries with the answer.

import { isRpcError } from '@kernel/rpc/contract'
import { clientUi } from '@kernel/interaction'
import { pathDisplayName, toAbsolutePath } from '@workspace/files/contract'
import type { EditorOp, EditorSnapshot } from '@panels/editor/contract'

type SendEditorOp = (op: EditorOp) => Promise<unknown>

/** The file an editor shows, as its session describes it: whether it is a
 *  draft is the runtime's call, never read off the path here. */
export type EditorFile = Pick<EditorSnapshot, 'filePath' | 'draft' | 'checkout'>

const dirOf = (file: string) => file.replace(/[/\\][^/\\]*$/, '')

/** The path a Save As suggests: in a draft's checkout, else the file's folder. */
function saveAsDefault(file: EditorFile & { filePath: string }, title: string): string {
  const named = title.trim() && title.trim() !== 'Untitled' ? title.trim() : ''
  const name = file.draft ? (named || 'Untitled.md') : pathDisplayName(file.filePath) || named || 'Untitled.txt'
  const folder = file.draft && file.checkout ? file.checkout : dirOf(file.filePath)
  return toAbsolutePath(name, folder)
}

export async function saveAs(send: SendEditorOp, workspaceId: string, file: EditorFile, title: string): Promise<boolean> {
  if (!file.filePath) return false
  const target = await clientUi().pickSavePath({
    workspaceId,
    defaultPath: saveAsDefault({ ...file, filePath: file.filePath }, title),
    rootPath: file.checkout ?? dirOf(file.filePath),
  })
  if (!target) return false
  await send({ kind: 'saveAs', path: target })
  return true
}

/** Save; a draft has no real destination yet, so it is a Save As. */
export async function save(send: SendEditorOp, workspaceId: string, file: EditorFile, title: string): Promise<boolean> {
  if (file.draft) return saveAs(send, workspaceId, file, title)
  await send({ kind: 'save' })
  return true
}

/** Asks what to do with unsaved edits before they would be left. Resolves
 *  `discard` when the person chose to drop them, `saved` after a save,
 *  `null` when they cancelled. */
export async function confirmUnsaved(
  send: SendEditorOp,
  workspaceId: string,
  snapshot: EditorFile & Pick<EditorSnapshot, 'dirty'>,
  title: string,
): Promise<'clean' | 'saved' | 'discard' | null> {
  if (!snapshot.dirty || !snapshot.filePath) return 'clean'
  const choice = await clientUi().confirmUnsavedChanges({ fileName: title, filePath: snapshot.filePath })
  if (choice === 'cancel') return null
  if (choice === 'discard') return 'discard'
  return (await save(send, workspaceId, snapshot, title)) ? 'saved' : null
}

/** Closes an editor panel, asking about unsaved edits first. The host's close
 *  action can use this for editor panels. */
export async function closeEditor(
  send: SendEditorOp,
  workspaceId: string,
  snapshot: EditorFile & Pick<EditorSnapshot, 'dirty'>,
  title: string,
): Promise<boolean> {
  try {
    await send({ kind: 'close' })
    return true
  } catch (err) {
    if (!isRpcError(err, 'dirty')) throw err
  }
  const answer = await confirmUnsaved(send, workspaceId, { ...snapshot, dirty: true }, title)
  if (!answer) return false
  await send({ kind: 'close', discard: answer === 'discard' })
  return true
}
