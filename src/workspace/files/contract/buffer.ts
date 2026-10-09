// Open buffers: one Yjs document per open file, shared by every editor showing
// it (architecture 9.4). The text lives in the document's `Y.Text` named
// BUFFER_TEXT; this file holds the state around it that every viewer sees.

/** Name of the `Y.Text` holding a buffer's content. */
export const BUFFER_TEXT = 'content'

/** Set when the file changed on disk under unsaved edits (`changed`) or was
 *  deleted (`deleted`). Carries what a view needs for a three-way merge. */
export type BufferConflict =
  | { kind: 'changed'; baseText: string; diskText: string; diskHash: string }
  | { kind: 'deleted'; baseText: string }

export interface BufferState {
  path: string
  /** Hash of the content the buffer was loaded from or last saved as; null
   *  when the file did not exist. A save fails with `conflict` when the disk
   *  no longer matches it. */
  baseHash: string | null
  dirty: boolean
  conflict: BufferConflict | null
  /** The file is not UTF-8 text: shown, never saved. */
  readOnly?: true
}

/** How a conflict is settled:
 *  - `reload`: take the disk content, dropping unsaved edits (also a plain
 *    revert when there is no conflict).
 *  - `keep`: keep the buffer; the disk version becomes the new base, so the
 *    next save overwrites it.
 *  - `merge`: three-way merge of base, buffer and disk into the buffer. */
export type BufferResolution = 'reload' | 'keep' | 'merge'

/** Events of the `file.buffer` stream. Yjs updates travel as byte chunks in
 *  both directions: the runtime sends the diff against the subscriber's state
 *  vector first, then every update; the client writes its own updates. */
export type BufferStreamEvent =
  | { kind: 'state'; state: BufferState }
  /** The runtime's state vector (base64). A client answers with the diff of
   *  what the runtime lacks, which covers edits made while disconnected. */
  | { kind: 'sync'; stateVector: string }

export type ExternalEventType = 'create' | 'update' | 'delete'
export type ExternalAction = 'reload' | 'conflict-changed' | 'conflict-deleted'

/** The smallest single replacement turning `from` into `to`: keep the common
 *  prefix and suffix. Applying a reload this way keeps remote cursors stable. */
export function textDelta(from: string, to: string): { index: number; remove: number; insert: string } | null {
  if (from === to) return null
  let start = 0
  const max = Math.min(from.length, to.length)
  while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++
  let endFrom = from.length
  let endTo = to.length
  while (endFrom > start && endTo > start && from.charCodeAt(endFrom - 1) === to.charCodeAt(endTo - 1)) {
    endFrom--
    endTo--
  }
  return { index: start, remove: endFrom - start, insert: to.slice(start, endTo) }
}
