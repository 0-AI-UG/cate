// Every panel type's definition, as data. Pure: clients read it to list types
// (the surface picker, menus) and build fresh records; the contract test runs
// `definitionProblems` over it. Adding a type is one import and one entry.

import type { PanelId, PanelRecord, PanelType, WorkspaceDocument } from '@workspace/document/contract'
import type { AnyPanelDefinition, PanelKit, PanelRecordInit } from './framework/contract'
import terminal from './terminal/definition'
import editor from './editor/definition'
import review from './review/definition'
import browser from './browser/definition'
import chat from './chat/definition'
import canvas from './canvas/definition'
import surface from './surface/definition'

export const PANEL_DEFINITIONS: readonly AnyPanelDefinition[] = [terminal, editor, review, browser, chat, canvas, surface]

const byType = new Map<string, AnyPanelDefinition>(PANEL_DEFINITIONS.map((definition) => [definition.type, definition]))

export function panelDefinition(type: PanelType | string): AnyPanelDefinition | undefined {
  return byType.get(type)
}

/** Types people create from menus, in creation order. */
export function creatableDefinitions(): AnyPanelDefinition[] {
  return PANEL_DEFINITIONS
    .filter((definition) => definition.creation)
    .sort((a, b) => a.creation!.order - b.creation!.order)
}

export interface FreshRecordOptions {
  title?: string
  worktreeId?: string
  /** The type's own create options (a url, a file path). */
  [option: string]: unknown
}

const newId = () => globalThis.crypto.randomUUID()

/**
 * A fresh record of `type`, built the way the runtime's `createPanel` builds
 * one: through the definition's `create` when it has one (with a kit that
 * captures the record instead of placing it), else from its `fields`. With
 * `id`, the record keeps that id (a surface becoming the picked type).
 */
export function freshRecord(doc: WorkspaceDocument, type: PanelType, options: FreshRecordOptions = {}, id?: PanelId): PanelRecord | null {
  const definition = panelDefinition(type)
  if (!definition) return null
  const make = (init: PanelRecordInit): PanelRecord => {
    const def = panelDefinition(type)!
    return {
      id: init.id,
      type,
      title: init.title ?? def.defaultTitle,
      ...(init.worktreeId ? { worktreeId: init.worktreeId } : {}),
      ...(init.canvasId ? { canvasId: init.canvasId } : {}),
      fields: init.fields ?? {},
    }
  }
  let captured: PanelRecord | null = null
  const kit: PanelKit = {
    newId,
    record: (_type, init) => make(init),
    add: (record) => { captured = record; return record.id },
    document: () => doc,
    numberedTitle: (panelType, base) => {
      const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(\\d+)$`)
      let max = 0
      for (const panel of Object.values(doc.panels)) {
        const match = panel.type === panelType ? re.exec(panel.title) : null
        if (match) max = Math.max(max, Number(match[1]))
      }
      return `${base} ${max + 1}`
    },
    uniqueTitle: (title, panelId) => {
      const taken = new Set(Object.values(doc.panels).filter((p) => p.id !== panelId).map((p) => p.title))
      if (!taken.has(title)) return title
      for (let n = 2; ; n++) if (!taken.has(`${title} ${n}`)) return `${title} ${n}`
    },
    worktreeIdForPath: (path) => {
      if (!path) return undefined
      let best: { id: string; length: number } | undefined
      for (const worktree of Object.values(doc.worktrees)) {
        const root = worktree.path.replace(/[/\\]+$/, '')
        const inside = path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`)
        if (inside && (!best || root.length > best.length)) best = { id: worktree.id, length: root.length }
      }
      return best?.id
    },
  }
  if (definition.create) definition.create(options, kit)
  else captured = make({ id: newId(), title: options.title, worktreeId: options.worktreeId, fields: definition.fields?.(options) ?? {} })
  const record = captured as PanelRecord | null
  return record && id ? { ...record, id } : record
}
