// A surface becomes the picked type in place: one `replacePanel` op with a
// fresh record of that type under the surface's id. The runtime disposes the
// surface session and starts the new one.

import type { DocumentStore } from '@client/document'
import type { ClientFeature } from '@kernel/rpc/contract'
import { isCanvasDock, placementOf, type PanelRecord, type PanelType, type WorkspaceDocument } from '@workspace/document/contract'
import { freshRecord, panelDefinition, splitMenuDefinitions } from '../../../definitions'
import type { AnyPanelDefinition } from '../../../framework/contract'

/** The types a surface can become where it sits, for a client with `has`. */
export function surfaceChoices(doc: WorkspaceDocument, surfaceId: string, has: (feature: ClientFeature) => boolean): AnyPanelDefinition[] {
  const placement = placementOf(doc, surfaceId)
  const onCanvas = !!placement && isCanvasDock(placement.dock)
  return splitMenuDefinitions().filter((definition) =>
    definition.type !== 'surface'
    && (!onCanvas || definition.canLiveOnCanvas)
    && definition.requires.every((feature) => has(feature)))
}

export function pickSurface(store: DocumentStore, surface: PanelRecord, type: PanelType): boolean {
  const definition = panelDefinition(type)
  if (!definition || type === 'surface') return false
  const doc = store.getSnapshot()
  if (!doc.panels[surface.id]) return false
  const placement = placementOf(doc, surface.id)
  if (!definition.canLiveOnCanvas && placement && isCanvasDock(placement.dock)) return false
  const record = freshRecord(doc, type, surface.worktreeId ? { worktreeId: surface.worktreeId } : {}, surface.id)
  if (!record) return false
  return store.propose({ kind: 'replacePanel', record }).ok
}
