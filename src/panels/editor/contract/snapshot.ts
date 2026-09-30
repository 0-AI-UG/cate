// The editor session channel (architecture 11.3): a plain JSON snapshot and
// the typed ops. The file text is not in the snapshot; views attach to the
// file's buffer (`file.buffer`) for it.

import type { BufferResolution, DocumentType } from '@workspace/files/contract'

export type EditorMode = 'code' | 'preview' | 'merge'

/** A reveal the runtime asked for (`cate editor open file:12`). Views apply
 *  each `seq` once; reveals a view asks for itself are client intents. */
export type EditorRevealRequest = { seq: number; line: number; column: number | null }

export type EditorSnapshot = {
  /** Null only before an untitled editor got its draft path. */
  filePath: string | null
  /** The checkout the file is in (its worktree, else the workspace root):
   *  the explorer root and where Save As starts. */
  checkout: string | null
  /** Set for files shown as a preview (image, PDF, DOCX); null for text. */
  documentType: DocumentType | null
  dirty: boolean
  /** The file changed or was deleted on disk under unsaved edits. */
  conflict: 'changed' | 'deleted' | null
  mode: EditorMode
  /** Set while the editor is shared with an agent (connected editors):
   *  edits autosave. `syncError` is the last failed autosave. */
  connectedDraft: { syncError: string | null } | null
  loading: boolean
  error: string | null
  reveal: EditorRevealRequest | null
}

export type EditorOp =
  | { kind: 'save' }
  /** Writes the buffer to `path` (the view picked it) and follows it there. */
  | { kind: 'saveAs'; path: string }
  | { kind: 'setMode'; mode: EditorMode }
  | { kind: 'resolveConflict'; resolution: BufferResolution }
  /** Shows another file in this panel. Fails `dirty` with unsaved edits
   *  unless `discard`. */
  | { kind: 'openFile'; path: string; line?: number; column?: number; discard?: boolean }
  /** Removes the panel. Fails `dirty` with unsaved edits unless `discard`. */
  | { kind: 'close'; discard?: boolean }
  /** Readies the panel for a removal the client sends next (its close
   *  guard): fails `dirty` with unsaved edits only this panel shows, unless
   *  `discard`, which reverts them when the panel goes. */
  | { kind: 'prepareClose'; discard?: boolean }
