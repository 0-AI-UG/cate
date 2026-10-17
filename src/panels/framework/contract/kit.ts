// The one panel kit a definition's `create` gets, on the client and in the
// runtime alike: fresh records, titles and the worktree a path is in. Only
// `add` differs (the runtime places the record, a client captures it).

import type { PanelId, PanelRecord, PanelType, WorkspaceDocument } from '@workspace/document/contract'
import { worktreeForPath } from '@workspace/repository/contract'
import type { AnyPanelDefinition, PanelKit, PanelPlacementOptions } from './definition'

export interface PanelKitDeps {
  document(): WorkspaceDocument
  newId(): PanelId
  definitionOf(type: PanelType): AnyPanelDefinition
  add(record: PanelRecord, placement?: PanelPlacementOptions): PanelId | null
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function createPanelKit(deps: PanelKitDeps): PanelKit {
  return {
    newId: deps.newId,
    record(type, init) {
      return {
        id: init.id,
        type,
        title: init.title ?? deps.definitionOf(type).defaultTitle,
        ...(init.worktreeId ? { worktreeId: init.worktreeId } : {}),
        ...(init.canvasId ? { canvasId: init.canvasId } : {}),
        fields: init.fields ?? {},
      }
    },
    add: deps.add,
    document: deps.document,
    numberedTitle(type, base) {
      const re = new RegExp(`^${escape(base)}\\s+(\\d+)$`)
      let max = 0
      for (const panel of Object.values(deps.document().panels)) {
        const match = panel.type === type ? re.exec(panel.title) : null
        if (match) max = Math.max(max, Number(match[1]))
      }
      return `${base} ${max + 1}`
    },
    uniqueTitle(title, panelId) {
      const taken = new Set(Object.values(deps.document().panels).filter((p) => p.id !== panelId).map((p) => p.title))
      if (!taken.has(title)) return title
      for (let n = 2; ; n++) if (!taken.has(`${title} ${n}`)) return `${title} ${n}`
    },
    worktreeIdForPath: (path) => worktreeForPath(path, Object.values(deps.document().worktrees))?.id,
  }
}
