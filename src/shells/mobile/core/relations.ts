// Relations for the app (architecture 9.7): each workspace's relation graph as
// the app shows it, whether relations are on there (the workspace setting,
// mirrored per connection), and the core API that edits them with the shared
// edits (workspace/relations client) on the document mirror.

import { runtimeFor } from '@kernel/rpc/client'
import type { ClientSettingsStore } from '@kernel/settings/client'
import { documentStoreFor } from '@client/document'
import { panelDefinition } from '@panels/definitions'
import type { SharedClientSettings } from '@panels/settings'
import { panelConnectionCurve } from '@workspace/canvas/contract'
import { dockPanels, type CanvasNode, type PanelRecord, type PanelRelation, type WorkspaceDocument } from '@workspace/document/contract'
import {
  isExecutionSurface,
  panelRelationLabel,
  panelRelationOptions,
  relationContextMode,
  relationFlows,
  relationPanelOf,
  type RelationRole,
} from '@workspace/relations/contract'
import {
  addRelation,
  forgetRelationLabel,
  labelRelation,
  relationTargets,
  rememberRelationLabel,
  removeRelation,
  renameRelationLabel,
  setRelationContextMode,
  updateRelationMeaning,
  type RelationLabelLibrary,
} from '@workspace/relations/client'
import type { MobileCoreMethods, MobilePanel, MobileRelation, MobileRelationCurve } from '../contract'
import type { MobileClient } from './boot'
import type { MobileWorkspaceSettings } from './workspaceSettings'

type Handlers<M extends keyof MobileCoreMethods> = {
  [K in M]: (params: MobileCoreMethods[K]['params']) => Promise<MobileCoreMethods[K]['result']>
}

export type RelationMethod =
  | 'relations.targets' | 'relations.options' | 'relations.connect' | 'relations.setKind'
  | 'relations.remove' | 'relations.setContextMode' | 'relations.preview'
  | 'relations.setLabel' | 'relations.renameLabel' | 'relations.forgetLabel'

export interface MobileRelations {
  /** The workspace setting `panelRelationsEnabled`; on until it is known. */
  enabled(workspaceId: string): boolean
  /** The client setting `savedPanelRelationLabels`. */
  savedLabels(): string[]
  subscribe(listener: () => void): () => void
}

const roleOf = (type: string): RelationRole | undefined => panelDefinition(type)?.relation

/** What the app shows of a panel's part in relations. */
export function relationFieldsOf(record: PanelRecord): Pick<MobilePanel, 'execution' | 'contextMode'> {
  return {
    execution: isExecutionSurface(relationPanelOf(record, roleOf)),
    contextMode: relationContextMode(record.fields),
  }
}

/** The relation's curve on the canvas whose nodes hold both its panels,
 *  as the desktop draws it. */
function curveOf(doc: WorkspaceDocument, relation: PanelRelation): MobileRelationCurve | null {
  for (const canvas of Object.values(doc.canvases)) {
    const nodeOf = (panelId: string): CanvasNode | undefined =>
      Object.values(canvas.nodes).find((node) => dockPanels(node.dock).includes(panelId))
    const from = nodeOf(relation.fromPanelId)
    const to = nodeOf(relation.toPanelId)
    if (!from || !to) continue
    if (from.id === to.id) return null
    const curve = panelConnectionCurve(from.rect, to.rect, relation.fromSide, relation.toSide, relation.waypoint)
    return curve && { canvasId: canvas.id, fromNodeId: from.id, toNodeId: to.id, ...curve }
  }
  return null
}

/** The document's relations as the app shows them. */
export function relationsOf(doc: WorkspaceDocument): MobileRelation[] {
  const relations = Object.values(doc.relations)
  const flows = relationFlows(relations, doc.panels, roleOf)
  return relations.flatMap((relation): MobileRelation[] => {
    const from = doc.panels[relation.fromPanelId]
    const to = doc.panels[relation.toPanelId]
    if (!from || !to) return []
    const source = relationPanelOf(from, roleOf)
    const target = relationPanelOf(to, roleOf)
    return [{
      id: relation.id,
      fromPanelId: relation.fromPanelId,
      toPanelId: relation.toPanelId,
      kind: relation.kind,
      flow: flows.get(relation.id) ?? null,
      label: panelRelationLabel(relation, source, target),
      custom: relation.label?.trim() || null,
      curve: curveOf(doc, relation),
      options: panelRelationOptions(source, target),
    }]
  })
}

export function createMobileRelations(client: MobileClient, settings: MobileWorkspaceSettings): MobileRelations {
  return {
    enabled: (workspaceId) => settings.of(workspaceId)?.get('panelRelationsEnabled') ?? true,
    savedLabels: () => client.settings.get('savedPanelRelationLabels'),
    subscribe(listener) {
      const offWorkspace = settings.subscribe(listener)
      const offClient = client.settings.subscribe(listener)
      return () => { offWorkspace(); offClient() }
    },
  }
}

export function createRelationHandlers(settings: ClientSettingsStore<SharedClientSettings>): Handlers<RelationMethod> {
  const store = (workspaceId: string) => documentStoreFor(workspaceId)
  const library: RelationLabelLibrary = {
    get: () => settings.get('savedPanelRelationLabels'),
    set: (labels) => { settings.set('savedPanelRelationLabels', labels) },
  }
  return {
    async 'relations.targets'({ workspaceId, panelId }) {
      const doc = store(workspaceId)?.getSnapshot()
      return doc?.panels[panelId] ? relationTargets(doc, panelId, roleOf).map((panel) => panel.id) : []
    },
    async 'relations.options'({ workspaceId, fromPanelId, toPanelId }) {
      const doc = store(workspaceId)?.getSnapshot()
      const from = doc?.panels[fromPanelId]
      const to = doc?.panels[toPanelId]
      return from && to ? panelRelationOptions(relationPanelOf(from, roleOf), relationPanelOf(to, roleOf)) : []
    },
    async 'relations.connect'({ workspaceId, fromPanelId, toPanelId, kind }) {
      const doc = store(workspaceId)
      return !!doc && addRelation(doc, roleOf, fromPanelId, toPanelId, kind) !== null
    },
    async 'relations.setKind'({ workspaceId, relationId, kind }) {
      const doc = store(workspaceId)
      const relation = doc?.getSnapshot().relations[relationId]
      return !!doc && !!relation && updateRelationMeaning(doc, relationId, kind)
    },
    async 'relations.setLabel'({ workspaceId, relationId, label, remember }) {
      const doc = store(workspaceId)
      if (!doc || !labelRelation(doc, relationId, label)) return false
      if (remember) rememberRelationLabel(library, label)
      return true
    },
    async 'relations.renameLabel'({ label, to }) {
      renameRelationLabel(library, label, to)
      return null
    },
    async 'relations.forgetLabel'({ label }) {
      forgetRelationLabel(library, label)
      return null
    },
    async 'relations.remove'({ workspaceId, relationId }) {
      const doc = store(workspaceId)
      return !!doc && removeRelation(doc, relationId)
    },
    async 'relations.setContextMode'({ workspaceId, panelId, mode }) {
      const doc = store(workspaceId)
      return !!doc && setRelationContextMode(doc, panelId, mode)
    },
    async 'relations.preview'({ workspaceId, panelId }) {
      return runtimeFor(workspaceId).agents.previewContext({ panelId }).catch(() => null)
    },
  }
}
