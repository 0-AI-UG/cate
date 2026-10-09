// Relation edits on a workspace's document mirror, the same for every client.
// Relations are document data: each edit is one op proposed on the mirror.

import type { Point } from '@workspace/canvas/contract'
import type { DocBatch, DocChange, PanelRecord, RelationKind, RelationSide, WorkspaceDocument } from '@workspace/document/contract'
import {
  RELATION_CONTEXT_MODE_FIELD,
  wouldCreatePanelRelationCycle,
  type RelationContextMode,
} from '../contract'

/** The part of a document mirror the edits use (`documentStoreFor` fits). */
export interface RelationDocument {
  getSnapshot(): WorkspaceDocument
  propose(change: DocChange | DocBatch): { ok: boolean }
}

/** Adds a relation, or re-points the existing one for the same pair. Returns
 *  its id, or null when the op failed. */
export function addRelation(
  store: RelationDocument,
  fromPanelId: string,
  toPanelId: string,
  kind: RelationKind,
  fromSide?: RelationSide,
  toSide?: RelationSide,
): string | null {
  if (fromPanelId === toPanelId) return null
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
export function updateRelationMeaning(store: RelationDocument, relationId: string, kind: RelationKind, label?: string): boolean {
  return store.propose({ kind: 'updateRelation', id: relationId, patch: { kind, label: label?.trim() || null } }).ok
}

export function moveRelation(store: RelationDocument, relationId: string, waypoint: Point): void {
  store.propose({ kind: 'updateRelation', id: relationId, patch: { waypoint } })
}

export function removeRelation(store: RelationDocument, relationId: string): boolean {
  return store.propose({ kind: 'removeRelation', id: relationId }).ok
}

export function setRelationContextMode(store: RelationDocument, panelId: string, mode: RelationContextMode): boolean {
  return store.propose({ kind: 'updatePanel', id: panelId, patch: { fields: { [RELATION_CONTEXT_MODE_FIELD]: mode } } }).ok
}

/** The panels `sourcePanelId` can connect to: every other panel a relation
 *  to would not close a cycle. */
export function relationTargets(doc: WorkspaceDocument, sourcePanelId: string): PanelRecord[] {
  const relations = Object.values(doc.relations)
  return Object.values(doc.panels).filter((panel) =>
    panel.id !== sourcePanelId && !wouldCreatePanelRelationCycle(relations, sourcePanelId, panel.id))
}
