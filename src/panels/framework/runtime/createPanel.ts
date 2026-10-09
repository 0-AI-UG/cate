// `createPanel(type, options)` on the runtime: builds the record through the
// type's definition and places it with one `addPanel` op, where
// `placeTargetFor` (framework contract) says.

import { randomUUID } from 'node:crypto'
import type { PanelId, PanelRecord, PanelType } from '@workspace/document/contract'
import type { DocumentService } from '@workspace/document/runtime'
import { createPanelKit, placeTargetFor, type AnyPanelDefinition, type PanelCreateOptions, type PanelKit } from '../contract'
import type { PanelRegistry } from './registry'

export interface PanelFactoryDeps {
  document: DocumentService
  registry: PanelRegistry
  newId?: () => string
}

export interface PanelFactory {
  /** Returns the new panel's id, or null when it could not be created. */
  /** `options` may carry the type's own create options (url, filePath). */
  createPanel(type: string, options?: PanelCreateOptions & Record<string, unknown>): PanelId | null
  readonly kit: PanelKit
}

export function createPanelFactory(deps: PanelFactoryDeps): PanelFactory {
  const newId = deps.newId ?? (() => randomUUID())
  const definitionOf = (type: string): AnyPanelDefinition => {
    const entry = deps.registry.get(type)
    if (!entry) throw new Error(`unknown panel type ${type}`)
    return entry.definition
  }

  const kit: PanelKit = createPanelKit({
    document: () => deps.document.get(),
    newId,
    definitionOf,
    add(record, placement = {}) {
      const at = placeTargetFor(deps.document.get(), definitionOf(record.type), placement, newId)
      try {
        deps.document.apply({ kind: 'addPanel', record, at })
        return record.id
      } catch {
        return null
      }
    },
  })

  return {
    kit,
    createPanel(type, options = {}) {
      const definition = deps.registry.get(type)?.definition
      if (!definition) return null
      if (definition.create) return definition.create(options, kit)
      const record: PanelRecord = kit.record(type as PanelType, {
        id: newId(),
        title: options.title,
        worktreeId: options.worktreeId,
        fields: definition.fields?.(options) ?? {},
      })
      return kit.add(record, options)
    },
  }
}
