// What the view asks its user before sending an op (architecture 11.2 rule
// 6): where to save, and what to do with unsaved edits. The session never
// asks; it fails `dirty` and the view retries with the answer.

import { isRpcError } from '@kernel/rpc/contract'
import { clientUi } from '@kernel/ui'
import { clientHas } from '@client/connections'
import { pathDisplayName, toAbsolutePath } from '@workspace/files/contract'
import { DRAFTS_DIR, isEditorDraft } from '@workspace/relations/contract'
import type { EditorOp, EditorSnapshot } from '../contract'

type SendEditorOp = (op: EditorOp) => Promise<unknown>

/** Asks for a path in the app when the client has no native save dialog. */
export type PathPrompt = (request: { title: string; initial: string }) => Promise<string | null>

const dirOf = (file: string) => file.replace(/[/\\][^/\\]*$/, '')

/** The folder a Save As starts in: a draft's checkout, else the file's folder. */
function saveAsFolder(filePath: string): string {
  const dir = dirOf(filePath)
  return isEditorDraft(filePath) ? dir.slice(0, dir.length - DRAFTS_DIR.length - 1) : dir
}

function saveAsDefaults(filePath: string, title: string): { defaultName: string; defaultPath: string } {
  const named = title.trim() && title.trim() !== 'Untitled' ? title.trim() : ''
  const defaultName = isEditorDraft(filePath) ? (named || 'Untitled.md') : pathDisplayName(filePath) || named || 'Untitled.txt'
  const folder = saveAsFolder(filePath)
  return { defaultName, defaultPath: folder ? `${folder}/${defaultName}` : defaultName }
}

/** Picks a destination: the native dialog with `osFiles`, else the prompt. */
async function pickSavePath(filePath: string, title: string, prompt?: PathPrompt): Promise<string | null> {
  const defaults = saveAsDefaults(filePath, title)
  const dialog = clientHas('osFiles') ? clientUi().saveFileDialog : undefined
  if (dialog) return dialog(defaults)
  if (!prompt) return null
  const typed = (await prompt({ title: 'Save As', initial: defaults.defaultPath }))?.trim()
  return typed ? toAbsolutePath(typed, saveAsFolder(filePath)) : null
}

export async function saveAs(send: SendEditorOp, filePath: string, title: string, prompt?: PathPrompt): Promise<boolean> {
  const target = await pickSavePath(filePath, title, prompt)
  if (!target) return false
  await send({ kind: 'saveAs', path: target })
  return true
}

/** Save; a draft has no real destination yet, so it is a Save As. */
export async function save(send: SendEditorOp, filePath: string, title: string, prompt?: PathPrompt): Promise<boolean> {
  if (isEditorDraft(filePath)) return saveAs(send, filePath, title, prompt)
  await send({ kind: 'save' })
  return true
}

/** Asks what to do with unsaved edits before they would be left. Resolves
 *  `discard` when the person chose to drop them, `saved` after a save,
 *  `null` when they cancelled. */
export async function confirmUnsaved(
  send: SendEditorOp,
  snapshot: Pick<EditorSnapshot, 'filePath' | 'dirty'>,
  title: string,
  prompt?: PathPrompt,
): Promise<'clean' | 'saved' | 'discard' | null> {
  if (!snapshot.dirty || !snapshot.filePath) return 'clean'
  const choice = await clientUi().confirmUnsavedChanges({ fileName: title, filePath: snapshot.filePath })
  if (choice === 'cancel') return null
  if (choice === 'discard') return 'discard'
  return (await save(send, snapshot.filePath, title, prompt)) ? 'saved' : null
}

/** Closes an editor panel, asking about unsaved edits first. The host's close
 *  action can use this for editor panels. */
export async function closeEditor(
  send: SendEditorOp,
  snapshot: Pick<EditorSnapshot, 'filePath' | 'dirty'>,
  title: string,
  prompt?: PathPrompt,
): Promise<boolean> {
  try {
    await send({ kind: 'close' })
    return true
  } catch (err) {
    if (!isRpcError(err, 'dirty')) throw err
  }
  const answer = await confirmUnsaved(send, { ...snapshot, dirty: true }, title, prompt)
  if (!answer) return false
  await send({ kind: 'close', discard: answer === 'discard' })
  return true
}
