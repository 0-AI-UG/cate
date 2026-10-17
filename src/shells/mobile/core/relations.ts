// Relations for the app (architecture 9.7): each workspace's relation graph as
// the app shows it, whether relations are on there (the workspace setting,
// mirrored per connection), and the core API that edits them with the shared
// edits (workspace/relations client) on the document mirror.

import { runtimeFor } from '@kernel/rpc/client'
import { createWorkspaceSettingsMirror, type WorkspaceSettingsMirror } from '@kernel/settings/client'
import { eachConnection } from '@client/connections'
import { documentStoreFor } from '@client/document'
import { panelDefinition } from '@panels/definitions'
import { workspaceSettingsTable, type WorkspaceSettings } from '@panels/settings'
import type { PanelRecord, WorkspaceDocument } from '@workspace/document/contract'
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
  relationTargets,
  removeRelation,
  setRelationContextMode,
  updateRelationMeaning,
} from '@workspace/relations/client'
import type { MobileCoreMethods, MobilePanel, MobileRelation } from '../contract'
import type { MobileClient } from './boot'

type Handlers<M extends keyof MobileCoreMethods> = {
  [K in M]: (params: MobileCoreMethods[K]['params']) => Promise<MobileCoreMethods[K]['result']>
}

export type RelationMethod =
  | 'relations.targets' | 'relations.options' | 'relations.connect' | 'relations.setKind'
  | 'relations.remove' | 'relations.setContextMode' | 'relations.preview'

export interface MobileRelations {
  /** The workspace setting `panelRelationsEnabled`; on until it is known. */
  enabled(workspaceId: string): boolean
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
      options: panelRelationOptions(source, target),
    }]
  })
}

export function createMobileRelations(client: MobileClient): MobileRelations {
  const settings = new Map<string, WorkspaceSettingsMirror<WorkspaceSettings>>()
  const listeners = new Set<() => void>()
  const changed = () => {
    for (const listener of [...listeners]) listener()
  }

  eachConnection(client.connections, ({ workspaceId, runtime }) => {
    const mirror = createWorkspaceSettingsMirror(runtime.settings, workspaceSettingsTable)
    settings.set(workspaceId, mirror)
    const off = mirror.subscribe(changed)
    return () => {
      off()
      mirror.dispose()
      if (settings.get(workspaceId) === mirror) settings.delete(workspaceId)
      changed()
    }
  })

  return {
    enabled: (workspaceId) => settings.get(workspaceId)?.get('panelRelationsEnabled') ?? true,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

export function createRelationHandlers(): Handlers<RelationMethod> {
  const store = (workspaceId: string) => documentStoreFor(workspaceId)
  return {
    async 'relations.targets'({ workspaceId, panelId }) {
      const doc = store(workspaceId)?.getSnapshot()
      return doc?.panels[panelId] ? relationTargets(doc, panelId).map((panel) => panel.id) : []
    },
    async 'relations.options'({ workspaceId, fromPanelId, toPanelId }) {
      const doc = store(workspaceId)?.getSnapshot()
      const from = doc?.panels[fromPanelId]
      const to = doc?.panels[toPanelId]
      return from && to ? panelRelationOptions(relationPanelOf(from, roleOf), relationPanelOf(to, roleOf)) : []
    },
    async 'relations.connect'({ workspaceId, fromPanelId, toPanelId, kind }) {
      const doc = store(workspaceId)
      return !!doc && addRelation(doc, fromPanelId, toPanelId, kind) !== null
    },
    async 'relations.setKind'({ workspaceId, relationId, kind }) {
      const doc = store(workspaceId)
      const relation = doc?.getSnapshot().relations[relationId]
      return !!doc && !!relation && updateRelationMeaning(doc, relationId, kind, relation.label)
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
