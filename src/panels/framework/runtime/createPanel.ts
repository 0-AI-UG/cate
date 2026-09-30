// `createPanel(type, options)` on the runtime: builds the record through the
// type's definition and places it with one `addPanel` op, where
// `placeTargetFor` (framework contract) says.

import { randomUUID } from 'node:crypto'
import type { PanelId, PanelRecord, PanelType } from '@workspace/document/contract'
import type { DocumentService } from '@workspace/document/runtime'
import { placeTargetFor, type AnyPanelDefinition, type PanelCreateOptions, type PanelKit } from '../contract'
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

  const kit: PanelKit = {
    newId,
    record(type, init) {
      const definition = definitionOf(type)
      return {
        id: init.id,
        type,
        title: init.title ?? definition.defaultTitle,
        ...(init.worktreeId ? { worktreeId: init.worktreeId } : {}),
        ...(init.canvasId ? { canvasId: init.canvasId } : {}),
        fields: init.fields ?? {},
      }
    },
    add(record, placement = {}) {
      const at = placeTargetFor(deps.document.get(), definitionOf(record.type), placement, newId)
      try {
        deps.document.apply({ kind: 'addPanel', record, at })
        return record.id
      } catch {
        return null
      }
    },
    document: () => deps.document.get(),
    numberedTitle(type, base) {
      const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(\\d+)$`)
      let max = 0
      for (const panel of Object.values(deps.document.get().panels)) {
        if (panel.type !== type) continue
        const match = re.exec(panel.title)
        if (match) max = Math.max(max, Number(match[1]))
      }
      return `${base} ${max + 1}`
    },
    uniqueTitle(title, panelId) {
      const taken = new Set(Object.values(deps.document.get().panels).filter((p) => p.id !== panelId).map((p) => p.title))
      if (!taken.has(title)) return title
      for (let n = 2; ; n++) if (!taken.has(`${title} ${n}`)) return `${title} ${n}`
    },
    worktreeIdForPath(path) {
      if (!path) return undefined
      let best: { id: string; length: number } | undefined
      for (const worktree of Object.values(deps.document.get().worktrees)) {
        const root = worktree.path.replace(/[/\\]+$/, '')
        const inside = path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`)
        if (inside && (!best || root.length > best.length)) best = { id: worktree.id, length: root.length }
      }
      return best?.id
    },
  }

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
