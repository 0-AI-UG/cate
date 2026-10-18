// The workspace document: panel records, windows and their dock trees,
// canvases, relations and worktree metadata. The runtime holds it; every
// client mirrors it. All ids are created by the sender of the op that
// introduces them (crypto.randomUUID() on clients).

import type { Point, Rect } from '@workspace/canvas/contract'
import type { DockNode } from './dock'

export type PanelId = string
export type WindowId = string
export type LayoutId = string
export type CanvasId = string
export type NodeId = string
export type StackId = string
export type SplitId = string
export type RelationId = string
export type WorktreeId = string
export type ClientId = string

/** The id of the one main window every document has. */
export const MAIN_WINDOW: WindowId = 'main'

/** The id of the main window's first layout. */
export const DEFAULT_LAYOUT: LayoutId = 'main'

/** The name a layout gets when none is given: fixed at creation, so moving a
 *  layout never renames it. The first free "Layout N" from the layout count up. */
export function defaultLayoutName(existing: readonly DockLayout[]): string {
  const taken = new Set(existing.map((l) => l.name))
  let n = existing.length + 1
  while (taken.has(`Layout ${n}`)) n++
  return `Layout ${n}`
}

/** Every panel type's name. The panel index holds one definition per name. */
export const PANEL_TYPES = ['terminal', 'editor', 'browser', 'review', 'canvas', 'surface'] as const
export type PanelType = (typeof PANEL_TYPES)[number]

export function isPanelType(value: unknown): value is PanelType {
  return typeof value === 'string' && (PANEL_TYPES as readonly string[]).includes(value)
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type JsonObject = { [key: string]: Json }

export interface PanelRecord {
  id: PanelId
  type: PanelType
  title: string
  worktreeId?: WorktreeId
  /** Canvas panels only, and required there: the canvas the panel shows. */
  canvasId?: CanvasId
  /** The type's own record fields, declared by its panel definition. */
  fields: JsonObject
}

/** One dock tree of a host (a window or a canvas node), like a tmux window:
 *  the host shows one layout at a time (which one is client state) and every
 *  panel is in exactly one dock. Layout ids are unique in the document, and a
 *  layout can move to another host. */
export interface DockLayout {
  id: LayoutId
  name: string
  /** Null for an empty layout. A layout that empties stays, empty: its window
   *  shows the creation menu there. */
  dock: DockNode | null
}

/** What holds layouts: a window, or one node of a canvas. */
export type HostRef = { windowId: WindowId } | { canvasId: CanvasId; nodeId: NodeId }

export interface DocWindow {
  id: WindowId
  kind: 'main' | 'detached'
  /** At least one, in switcher order. A detached window is removed when its
   *  last panel leaves, so it always has a panel in some layout. */
  layouts: DockLayout[]
}

/** One node on a canvas: a mini dock host at a rect. */
export interface CanvasNode {
  id: NodeId
  rect: Rect
  /** At least one, in switcher order, and not all empty (a node left with
   *  only empty layouts is removed). Never a layout with a canvas panel. */
  layouts: DockLayout[]
}

/** A canvas: its nodes, placed with `workspace/canvas` geometry. */
export interface CanvasModel {
  id: CanvasId
  /** In creation order: the last node is the newest. Stacking order is
   *  client state. */
  nodes: Record<NodeId, CanvasNode>
}

export type RelationKind = 'use' | 'context' | 'verify' | 'trigger'
export type RelationSide = 'top' | 'right' | 'bottom' | 'left'
export const RELATION_KINDS: readonly RelationKind[] = ['use', 'context', 'verify', 'trigger']
export const RELATION_SIDES: readonly RelationSide[] = ['top', 'right', 'bottom', 'left']

export interface PanelRelation {
  id: RelationId
  fromPanelId: PanelId
  toPanelId: PanelId
  kind: RelationKind
  /** User wording shown on the canvas; the kind stays the routing fallback. */
  label?: string
  fromSide?: RelationSide
  toSide?: RelationSide
  /** Canvas-space point the drawn curve passes through at its midpoint. */
  waypoint?: Point
}

export type WorktreeStatus = 'creating' | 'ready' | 'removing'
export const WORKTREE_STATUSES: readonly WorktreeStatus[] = ['creating', 'ready', 'removing']

/** Cate's facts about one worktree. Live git facts (branch, primary) come
 *  from the repository service and are never stored here. */
export interface WorktreeMeta {
  id: WorktreeId
  /** Absolute path of the checkout. */
  path: string
  color: string
  label?: string
  prNumber?: number
  status: WorktreeStatus
}

export interface WorkspaceDocument {
  panels: Record<PanelId, PanelRecord>
  /** `MAIN_WINDOW` always exists. */
  windows: Record<WindowId, DocWindow>
  canvases: Record<CanvasId, CanvasModel>
  relations: Record<RelationId, PanelRelation>
  worktrees: Record<WorktreeId, WorktreeMeta>
}

/** A new workspace: an empty main window and nothing else. */
export function createDocument(): WorkspaceDocument {
  return {
    panels: {},
    windows: { [MAIN_WINDOW]: { id: MAIN_WINDOW, kind: 'main', layouts: [{ id: DEFAULT_LAYOUT, name: defaultLayoutName([]), dock: null }] } },
    canvases: {},
    relations: {},
    worktrees: {},
  }
}
