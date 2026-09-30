// The workspace document: panel records, windows and their dock trees,
// canvases, relations and worktree metadata. The runtime holds it; every
// client mirrors it. All ids are created by the sender of the op that
// introduces them (crypto.randomUUID() on clients).

import type { CanvasModel, Point, Rect } from '@workspace/canvas/contract'
import type { DockNode } from './dock'

export type PanelId = string
export type WindowId = string
export type CanvasId = string
export type NodeId = string
export type StackId = string
export type SplitId = string
export type RelationId = string
export type WorktreeId = string
export type ClientId = string

/** The id of the one main window every document has. */
export const MAIN_WINDOW: WindowId = 'main'

/** Every panel type's name. The panel index holds one definition per name. */
export const PANEL_TYPES = ['terminal', 'editor', 'browser', 'chat', 'review', 'canvas', 'surface'] as const
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

export interface DocWindow {
  id: WindowId
  kind: 'main' | 'detached'
  /** Null only for an empty main window; a detached window is removed when
   *  its last panel leaves. */
  dock: DockNode | null
  /** Detached windows only. The main window's bounds are device state. */
  bounds?: Rect
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
    windows: { [MAIN_WINDOW]: { id: MAIN_WINDOW, kind: 'main', dock: null } },
    canvases: {},
    relations: {},
    worktrees: {},
  }
}
