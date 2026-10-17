// What the command palette lists, built from the document, the workspace list,
// the available actions and the panel definitions. Pure apart from what it is
// handed, so the listing rules are testable.

import { displayString, isIconName, type ActionId, type ActionSpec, type IconName, type StoredShortcut } from '@kernel/interaction/contract'
import { documentOrder, windowOf, type WindowId, type WorkspaceDocument } from '@workspace/document/contract'
import type { AnyPanelDefinition } from '@panels/framework/contract'
import { workspaceLocation, type WorkspaceEntry } from '@client/workspaces'

interface CommandItem {
  kind: 'command'
  id: string
  title: string
  icon: IconName | null
  shortcut?: string
  run(): void
}

interface WorkspaceItem {
  kind: 'workspace'
  id: string
  name: string
  detail?: string
  current: boolean
}

interface PanelItem {
  kind: 'panel'
  panelId: string
  title: string
  icon: IconName
  secondary: string
  /** Lives in another window of the workspace. */
  otherWindow: boolean
}

export interface FileItem {
  kind: 'file'
  path: string
  name: string
  relativePath: string
}

export type PaletteItem = CommandItem | WorkspaceItem | PanelItem | FileItem

export interface CommandSources {
  /** The actions that can run now, in declaration order. */
  actions: readonly { id: ActionId; spec: ActionSpec }[]
  shortcuts: Readonly<Record<ActionId, StoredShortcut>>
  runAction(action: ActionId): void
  /** Types created in a checkout (`creation.inWorktree`) this client can
   *  create, and the workspace's ready checkouts: with several, each pair is
   *  a "New <type> in <worktree>" command. */
  inWorktree: readonly AnyPanelDefinition[]
  worktrees: readonly { id: string; path: string; label: string }[]
  create(type: string, options: { worktreeId: string; cwd: string }): void
}

const matches = (query: string, ...texts: (string | undefined)[]): boolean =>
  !query || texts.some((t) => t?.toLowerCase().includes(query))

export function commandItems(src: CommandSources, query: string): CommandItem[] {
  const out: CommandItem[] = []
  for (const { id, spec } of src.actions) {
    if (spec.palette === false) continue
    const binding = src.shortcuts[id]
    out.push({
      kind: 'command',
      id,
      title: spec.title,
      icon: spec.icon ?? null,
      shortcut: binding?.key ? displayString(binding) : spec.keyHint,
      run: () => src.runAction(id),
    })
  }
  if (src.worktrees.length > 1) {
    for (const definition of src.inWorktree) {
      for (const worktree of src.worktrees) {
        out.push({
          kind: 'command',
          id: `new:${definition.type}:${worktree.id}`,
          title: `${definition.creation?.title ?? `New ${definition.label}`} in ${worktree.label}`,
          icon: isIconName(definition.icon) ? definition.icon : null,
          run: () => src.create(definition.type, { worktreeId: worktree.id, cwd: worktree.path }),
        })
      }
    }
  }
  return out.filter((item) => matches(query, item.title))
}

export function workspaceItems(entries: readonly WorkspaceEntry[], currentId: string | null, query: string): WorkspaceItem[] {
  return entries
    .map((entry): WorkspaceItem => ({
      kind: 'workspace',
      id: entry.id,
      name: entry.name,
      detail: workspaceLocation(entry) ?? undefined,
      current: entry.id === currentId,
    }))
    .filter((item) => matches(query, item.name, item.detail))
}

/** Navigable panels of the workspace in document order, this window's first. */
export function panelItems(
  doc: WorkspaceDocument,
  windowId: WindowId,
  definition: (type: string) => AnyPanelDefinition | undefined,
  query: string,
): PanelItem[] {
  const here: PanelItem[] = []
  const elsewhere: PanelItem[] = []
  for (const panelId of documentOrder(doc)) {
    const record = doc.panels[panelId]
    const def = record && definition(record.type)
    if (!record || !def?.navigable) continue
    const title = record.title || def.label
    if (!matches(query, title)) continue
    const otherWindow = windowOf(doc, panelId) !== windowId
    const item: PanelItem = {
      kind: 'panel',
      panelId,
      title,
      icon: isIconName(def.icon) ? def.icon : 'grid',
      secondary: otherWindow ? 'Other window' : def.describe?.(record) ?? def.label,
      otherWindow,
    }
    ;(otherWindow ? elsewhere : here).push(item)
  }
  return [...here, ...elsewhere]
}
