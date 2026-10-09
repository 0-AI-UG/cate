// Relation edits from the canvas: the shared edits (workspace/relations
// client) on the workspace's document mirror.

import { relationUiHost } from './host'
import type { Point } from '@workspace/canvas/contract'
import type { RelationKind, RelationSide } from '@workspace/document/contract'
import type { RelationContextMode } from '@workspace/relations/contract'
import * as edits from '@workspace/relations/client'

/** Adds a relation, or re-points the existing one for the same pair. Returns
 *  its id, or null when the op failed. */
export function addRelation(
  workspaceId: string,
  fromPanelId: string,
  toPanelId: string,
  kind: RelationKind,
  fromSide?: RelationSide,
  toSide?: RelationSide,
): string | null {
  const store = relationUiHost().document(workspaceId)
  return store ? edits.addRelation(store, fromPanelId, toPanelId, kind, fromSide, toSide) : null
}

/** Sets the meaning; no label falls back to the kind's wording. */
export function updateRelationMeaning(workspaceId: string, relationId: string, kind: RelationKind, label?: string): void {
  const store = relationUiHost().document(workspaceId)
  if (store) edits.updateRelationMeaning(store, relationId, kind, label)
}

export function moveRelation(workspaceId: string, relationId: string, waypoint: Point): void {
  const store = relationUiHost().document(workspaceId)
  if (store) edits.moveRelation(store, relationId, waypoint)
}

export function removeRelation(workspaceId: string, relationId: string): void {
  const store = relationUiHost().document(workspaceId)
  if (store) edits.removeRelation(store, relationId)
}

export function setRelationContextMode(workspaceId: string, panelId: string, mode: RelationContextMode): void {
  const store = relationUiHost().document(workspaceId)
  if (store) edits.setRelationContextMode(store, panelId, mode)
}
