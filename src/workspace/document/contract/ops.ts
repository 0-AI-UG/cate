// Document ops. Every op names what it changes by id, never by position. A
// change is one edit; an op is a change (or an atomic batch of changes) with
// the opId the runtime dedupes on.

import type { Point, Rect } from '@workspace/canvas/contract'
import type { DockNodeId, SplitSide } from './dock'
import type {
  CanvasId,
  ClientId,
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

/** A dock: one layout of a window, or a canvas node's mini dock. */
export type DockRef = { windowId: WindowId; layoutId: LayoutId } | { canvasId: CanvasId; nodeId: NodeId }

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
  /** A new detached window with its first layout. */
  | { to: 'window'; windowId: WindowId; layoutId: LayoutId; layoutName?: string; stackId: StackId }

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
  | { kind: 'closeWindow'; windowId: WindowId }
  /** A new empty layout at `index` in the switcher (last by default). */
  | { kind: 'addLayout'; windowId: WindowId; layoutId: LayoutId; name?: string; index?: number }
  /** Removes a layout with its panels. A window keeps at least one layout. */
  | { kind: 'removeLayout'; windowId: WindowId; layoutId: LayoutId }
  /** Moves a layout to `index` in the switcher (clamped). */
  | { kind: 'moveLayout'; windowId: WindowId; layoutId: LayoutId; index: number }
  /** A layout always has a name; a blank one is rejected. */
  | { kind: 'renameLayout'; windowId: WindowId; layoutId: LayoutId; name: string }
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
