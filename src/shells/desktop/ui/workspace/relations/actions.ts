// Relation edits from the canvas. Relations are document data: each edit is
// one op on the client's document mirror.

import { relationUiHost } from './host'
import type { Point } from '@workspace/canvas/contract'
import type { RelationKind, RelationSide } from '@workspace/document/contract'

export type RelationContextMode = 'once' | 'always' | 'off'

/** Record field holding when an execution panel attaches relation context. */
export const RELATION_CONTEXT_MODE_FIELD = 'relationContextMode'

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
  if (!store || fromPanelId === toPanelId) return null
  const doc = store.getSnapshot()
  if (!doc.panels[fromPanelId] || !doc.panels[toPanelId]) return null
  const existing = Object.values(doc.relations).find((r) => r.fromPanelId === fromPanelId && r.toPanelId === toPanelId)
  if (existing) {
    const result = store.propose({
      kind: 'updateRelation',
      id: existing.id,
      patch: { kind, fromSide: fromSide ?? null, toSide: toSide ?? null },
    })
    return result.ok ? existing.id : null
  }
  const id = globalThis.crypto.randomUUID()
  const result = store.propose({
    kind: 'addRelation',
    relation: { id, fromPanelId, toPanelId, kind, ...(fromSide ? { fromSide } : {}), ...(toSide ? { toSide } : {}) },
  })
  return result.ok ? id : null
}

/** Sets the meaning; no label falls back to the kind's wording. */
export function updateRelationMeaning(workspaceId: string, relationId: string, kind: RelationKind, label?: string): void {
  relationUiHost().document(workspaceId)?.propose({
    kind: 'updateRelation',
    id: relationId,
    patch: { kind, label: label?.trim() || null },
  })
}

export function moveRelation(workspaceId: string, relationId: string, waypoint: Point): void {
  relationUiHost().document(workspaceId)?.propose({ kind: 'updateRelation', id: relationId, patch: { waypoint } })
}

export function removeRelation(workspaceId: string, relationId: string): void {
  relationUiHost().document(workspaceId)?.propose({ kind: 'removeRelation', id: relationId })
}

export function relationContextMode(fields: Record<string, unknown>): RelationContextMode {
  const mode = fields[RELATION_CONTEXT_MODE_FIELD]
  return mode === 'always' || mode === 'off' ? mode : 'once'
}

export function setRelationContextMode(workspaceId: string, panelId: string, mode: RelationContextMode): void {
  relationUiHost().document(workspaceId)?.propose({
    kind: 'updatePanel',
    id: panelId,
    patch: { fields: { [RELATION_CONTEXT_MODE_FIELD]: mode } },
  })
}
