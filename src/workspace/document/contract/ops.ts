// Document ops. Every op names what it changes by id, never by position. A
// change is one edit; an op is a change (or an atomic batch of changes) with
// the opId the runtime dedupes on.

import type { Point, Rect } from '@workspace/canvas/contract'
import type { DockNodeId, SplitSide } from './dock'
import type {
  CanvasId,
  ClientId,
  Json,
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

/** A dock: a window's, or a canvas node's mini dock. */
export type DockRef = { windowId: WindowId } | { canvasId: CanvasId; nodeId: NodeId }

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
  /** A new canvas node. */
  | { to: 'canvas'; canvasId: CanvasId; nodeId: NodeId; stackId: StackId; rect: Rect }
  /** A new detached window. */
  | { to: 'window'; windowId: WindowId; stackId: StackId; bounds: Rect }

export interface PanelPatch {
  title?: string
  /** null unbinds. */
  worktreeId?: WorktreeId | null
  /** Merged key by key; null removes the key. */
  fields?: { [key: string]: Json }
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
   *  picked type). */
  | { kind: 'replacePanel'; record: PanelRecord }
  | { kind: 'updatePanel'; id: PanelId; patch: PanelPatch }
  | { kind: 'removePanels'; ids: PanelId[] }
  | { kind: 'placePanel'; id: PanelId; at: PlaceTarget }
  | { kind: 'setSplitRatio'; splitId: SplitId; ratios: number[] }
  | { kind: 'setNodeRects'; canvasId: CanvasId; rects: { nodeId: NodeId; rect: Rect }[] }
  | { kind: 'setWindowBounds'; windowId: WindowId; bounds: Rect }
  | { kind: 'closeWindow'; windowId: WindowId }
  /** Gathers every tab of a split window into `stackId`. */
  | { kind: 'maximizeStack'; windowId: WindowId; stackId: StackId }
  /** Moves a canvas pane into the window showing its canvas, after the
   *  canvas tab. */
  | { kind: 'maximizePanel'; id: PanelId }
  /** Puts back what the window's maximize changed. */
  | { kind: 'restoreLayout'; windowId: WindowId }
  | { kind: 'addRelation'; relation: PanelRelation }
  | { kind: 'updateRelation'; id: RelationId; patch: RelationPatch }
  | { kind: 'removeRelation'; id: RelationId }
  | { kind: 'setWorktree'; worktree: WorktreeMeta }
  | { kind: 'removeWorktree'; id: WorktreeId }

export type DocChangeKind = DocChange['kind']

export interface DocBatch {
  kind: 'batch'
  changes: DocChange[]
}

export type DocOp = (DocChange | DocBatch) & { opId: OpId }

/** `gone`: the op names an id that does not exist. `rejected`: the op is
 *  malformed or breaks a rule (unknown panel type, a canvas on a canvas, an
 *  id already in use, ...). */
export type OpErrorCode = 'gone' | 'rejected'

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
