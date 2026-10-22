// Relation edits from the canvas: the shared edits (workspace/relations
// client) on the workspace's document mirror.

import { relationRoleOf, relationUiHost } from './host'
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
  return store ? edits.addRelation(store, relationRoleOf, fromPanelId, toPanelId, kind, fromSide, toSide) : null
}

/** Sets the meaning; no label falls back to the kind's wording. */
export function updateRelationMeaning(workspaceId: string, relationId: string, kind: RelationKind, label?: string): void {
  const store = relationUiHost().document(workspaceId)
  if (store) edits.updateRelationMeaning(store, relationId, kind, label)
}

/** Gives the relation words of its own, its kind kept. */
export function labelRelation(workspaceId: string, relationId: string, label: string): void {
  const store = relationUiHost().document(workspaceId)
  if (store) edits.labelRelation(store, relationId, label)
}

/** The saved label library, on this device's client settings. */
export function rememberRelationLabel(label: string): void {
  edits.rememberRelationLabel(relationUiHost().savedLabels, label)
}

export function renameRelationLabel(label: string, to: string): void {
  edits.renameRelationLabel(relationUiHost().savedLabels, label, to)
}

export function forgetRelationLabel(label: string): void {
  edits.forgetRelationLabel(relationUiHost().savedLabels, label)
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
