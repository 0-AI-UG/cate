// Document ops. Every op names what it changes by id, never by position. A
// change is one edit; an op is a change (or an atomic batch of changes) with
// the opId the runtime dedupes on.

import type { Point, Rect } from '@workspace/canvas/contract'
import type { DockNodeId, SplitSide } from './dock'
import type {
  CanvasId,
  ClientId,
  HostRef,
  Json,
  LayoutId,
  NodeId,
  PanelId,
  PanelRecord,
  PanelRelation,
  RelationId,
  RelationKind,
  RelationSide,
  SplitId,
  StackId,
  WindowId,
  WorktreeId,
  WorktreeMeta,
} from './schema'

/** A client numbers its ops 1, 2, 3, ... The runtime applies each
 *  `(clientId, counter)` at most once. */
export interface OpId {
  clientId: ClientId
  counter: number
}

/** A dock: one layout, wherever its host (a window or a canvas node) is. */
export interface DockRef {
  layoutId: LayoutId
}

/** Where a moved layout goes. New ids are the sender's. */
export type LayoutTarget =
  /** An existing host, at `index` in its switcher (last by default). */
  | { to: 'host'; host: HostRef; index?: number }
  /** A new detached window. */
  | { to: 'window'; windowId: WindowId }
  /** A new canvas node. */
  | { to: 'canvas'; canvasId: CanvasId; nodeId: NodeId; rect: Rect }

/** Where a panel goes. New ids (`stackId` and `splitId` of a split, the
 *  node of a canvas target, the window of a window target) are the sender's. */
export type PlaceTarget =
  /** A tab in an existing stack: after `after`, first when null, last when
   *  absent or when `after` is not in the stack. In an empty main window
   *  `stackId` names the stack to create. */
  | { to: 'stack'; dock: DockRef; stackId: StackId; after?: PanelId | null }
  /** A new stack `stackId` beside the stack or split `beside`. `splitId` is
   *  used only when a new split node is needed. */
  | { to: 'split'; dock: DockRef; beside: DockNodeId; side: SplitSide; stackId: StackId; splitId: SplitId }
  /** A new canvas node with its first layout. */
  | { to: 'canvas'; canvasId: CanvasId; nodeId: NodeId; layoutId: LayoutId; layoutName?: string; stackId: StackId; rect: Rect }
  /** A new layout holding only this panel, at `index` among the host's layouts
   *  (last by default; counted after the panel left its old layout). */
  | { to: 'tab'; host: HostRef; layoutId: LayoutId; layoutName?: string; stackId: StackId; index?: number }
  /** A new detached window with its first layout. */
  | { to: 'window'; windowId: WindowId; layoutId: LayoutId; layoutName?: string; stackId: StackId }

export interface PanelPatch {
  title?: string
  /** null unbinds. */
  worktreeId?: WorktreeId | null
  /** Merged key by key; null removes the key. */
  fields?: { [key: string]: Json }
}

/** A panel record field: a person chose the title (a rename, or a title given
 *  when the panel was made), so an agent's session title never replaces it. */
export const PANEL_TITLE_CHOSEN_FIELD = 'titleUserOverridden'

/** A person renaming a panel. */
export function renamePanelChange(id: PanelId, title: string): DocChange {
  return { kind: 'updatePanel', id, patch: { title, fields: { [PANEL_TITLE_CHOSEN_FIELD]: true } } }
}

export interface RelationPatch {
  kind?: RelationKind
  /** null removes. */
  label?: string | null
  fromSide?: RelationSide | null
  toSide?: RelationSide | null
  waypoint?: Point | null
}

export type DocChange =
  | { kind: 'addPanel'; record: PanelRecord; at: PlaceTarget }
  /** Same id and placement, new type and fields (a surface becoming the
   *  picked type). The old session is dropped, so like a removal it is
   *  refused `dirty` when that would lose work, unless `discard` is set. */
  | { kind: 'replacePanel'; record: PanelRecord; discard?: boolean }
  | { kind: 'updatePanel'; id: PanelId; patch: PanelPatch }
  /** `discard`: panels whose unsaved work the user chose to drop (11.2 rule
   *  6). Without it, a removal that would lose work is refused `dirty`. */
  | { kind: 'removePanels'; ids: PanelId[]; discard?: PanelId[] }
  | { kind: 'placePanel'; id: PanelId; at: PlaceTarget }
  | { kind: 'setSplitRatio'; splitId: SplitId; ratios: number[] }
  | { kind: 'setNodeRects'; canvasId: CanvasId; rects: { nodeId: NodeId; rect: Rect }[] }
  /** Removes the window's panels; `discard` as for `removePanels`. */
  | { kind: 'closeWindow'; windowId: WindowId; discard?: PanelId[] }
  /** A new empty layout at `index` in the host's switcher (last by default). */
  | { kind: 'addLayout'; host: HostRef; layoutId: LayoutId; name?: string; index?: number }
  /** Removes a layout with its panels (`discard` as for `removePanels`). A host keeps at least one layout. */
  | { kind: 'removeLayout'; layoutId: LayoutId; discard?: PanelId[] }
  /** Moves a layout to another host or within its own switcher. The main
   *  window keeps at least one layout, a layout with a canvas panel cannot go
   *  to a canvas node, and a new host needs a layout with panels. A host left
   *  with only empty layouts is removed, like a detached window. */
  | { kind: 'moveLayout'; layoutId: LayoutId; to: LayoutTarget }
  /** A layout always has a name; a blank one is rejected. */
  | { kind: 'renameLayout'; layoutId: LayoutId; name: string }
  | { kind: 'addRelation'; relation: PanelRelation }
  | { kind: 'updateRelation'; id: RelationId; patch: RelationPatch }
  | { kind: 'removeRelation'; id: RelationId }
  | { kind: 'setWorktree'; worktree: WorktreeMeta }
  | { kind: 'removeWorktree'; id: WorktreeId }

export interface DocBatch {
  kind: 'batch'
  changes: DocChange[]
}

export type DocOp = (DocChange | DocBatch) & { opId: OpId }

/** `gone`: the op names an id that does not exist. `rejected`: the op is
 *  malformed or breaks a rule (unknown panel type, a canvas on a canvas, an
 *  id already in use, ...). */
/** `dirty`: a removal that would lose work without the user's choice. */
export type OpErrorCode = 'gone' | 'rejected' | 'dirty'

export interface OpError {
  code: OpErrorCode
  message: string
}

export interface OpResult<D> {
  doc: D
  error?: OpError
}

export function sameOpId(a: OpId, b: OpId): boolean {
  return a.clientId === b.clientId && a.counter === b.counter
}

/** The changes an op makes, in order. */
export function opChanges(op: DocChange | DocBatch): DocChange[] {
  return op.kind === 'batch' ? op.changes : [op]
}
