// The editor session channel (architecture 11.3): a plain JSON snapshot and
// the typed ops. The file text is not in the snapshot; views attach to the
// file's buffer (`file.buffer`) for it.

import { pathKey, type BufferResolution, type DocumentType } from '@workspace/files/contract'

/** What a client shows of a text file: its source, or a markdown file's
 *  preview. Each client picks its own (client state); a conflict's diff is
 *  shared (`merging`). */
export type EditorMode = 'code' | 'preview'

/** A client's pick, for the file it was made on. */
export type EditorModeChoice = { filePath: string; mode: EditorMode }

/** A reveal the runtime asked for (`cate editor open file:12`). Views apply
 *  each `seq` once; reveals a view asks for itself are client intents. */
export type EditorRevealRequest = { seq: number; line: number; column: number | null }

export type EditorSnapshot = {
  /** Null only before an untitled editor got its draft path. */
  filePath: string | null
  /** The checkout the file is in (its worktree, else the workspace root):
   *  the explorer root and where Save As starts. */
  checkout: string | null
  /** An untitled editor's working file (connected editors): it has no real
   *  destination yet, so Save is a Save As into `checkout`. */
  draft: boolean
  /** Set for files shown as a preview (image, PDF, DOCX); null for text. */
  documentType: DocumentType | null
  dirty: boolean
  /** The file changed or was deleted on disk under unsaved edits. */
  conflict: 'changed' | 'deleted' | null
  /** The diff of an on-disk change is shown (to resolve the conflict). */
  merging: boolean
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
  /** Shows or hides the diff of a `changed` conflict. */
  | { kind: 'showMerge'; show: boolean }
  | { kind: 'resolveConflict'; resolution: BufferResolution }
  /** Shows another file in this panel. Fails `dirty` with unsaved edits
   *  unless `discard`. */
  | { kind: 'openFile'; path: string; line?: number; column?: number; discard?: boolean }
  /** Shows the same file in another worktree's checkout; where it is missing
   *  (or the panel shows a draft), a draft there with the current text.
   *  Null is the workspace root. Fails `dirty` with unsaved edits unless
   *  `discard`. */
  | { kind: 'switchWorktree'; worktreeId: string | null; discard?: boolean }
  /** Removes the panel. Fails `dirty` with unsaved edits unless `discard`. */
  | { kind: 'close'; discard?: boolean }
  /** Readies the panel for a removal the client sends next (its close
   *  guard): fails `dirty` with unsaved edits only this panel shows, unless
   *  `discard`, which reverts them when the panel goes. */
  /** Fails `dirty` when closing this panel, with the panels in `closing`,
   *  would lose unsaved edits. Changes nothing. */
  | { kind: 'prepareClose'; closing?: string[] }

const isMarkdown = (file: string) => /\.mdx?$/i.test(file)

/** A text file that has a preview besides its source. */
export function canPreview(snapshot: Pick<EditorSnapshot, 'filePath' | 'documentType'>): boolean {
  return !!snapshot.filePath && !snapshot.documentType && isMarkdown(snapshot.filePath)
}

/** What this client shows: its pick for the current file, else the preview
 *  of a saved markdown file, else the source. */
export function editorModeOf(snapshot: Pick<EditorSnapshot, 'filePath' | 'documentType' | 'draft'>, choice: unknown): EditorMode {
  if (!canPreview(snapshot)) return 'code'
  const pick = choice as Partial<EditorModeChoice> | null | undefined
  if (pick && typeof pick.filePath === 'string' && pathKey(pick.filePath) === pathKey(snapshot.filePath!)
    && (pick.mode === 'code' || pick.mode === 'preview')) return pick.mode
  return snapshot.draft ? 'code' : 'preview'
}
