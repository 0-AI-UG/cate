// What the command palette lists, built from the document, the workspace list,
// the action registry and panel definitions. Pure apart from the registries it
// is handed, so the listing rules are testable.

import type { ClientFeature } from '@kernel/rpc/contract'
import { SHORTCUT_DISPLAY_NAMES, displayString, isIconName, type IconName, type ShortcutAction, type StoredShortcut } from '@kernel/ui/contract'
import { documentOrder, windowOf, type PanelRecord, type WindowId, type WorkspaceDocument } from '@workspace/document/contract'
import type { AnyPanelDefinition } from '@panels/framework/contract'
import type { WorkspaceEntry } from '@client/workspaces'
import type { PaletteCommand } from '../actions/registry'

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
  actions: readonly ShortcutAction[]
  shortcuts: Record<ShortcutAction, StoredShortcut>
  runAction(action: ShortcutAction): void
  commands: readonly PaletteCommand[]
  /** The focused panel and its definition, for its own commands. */
  focused: { record: PanelRecord; definition: AnyPanelDefinition } | null
  sendOp(panelId: string, op: unknown): void
  clientHas(feature: ClientFeature): boolean
}

const matches = (query: string, ...texts: (string | undefined)[]): boolean =>
  !query || texts.some((t) => t?.toLowerCase().includes(query))

export function commandItems(src: CommandSources, query: string): CommandItem[] {
  const out: CommandItem[] = []
  for (const action of src.actions) {
    const binding = src.shortcuts[action]
    out.push({
      kind: 'command',
      id: action,
      title: SHORTCUT_DISPLAY_NAMES[action],
      icon: null,
      shortcut: binding.key ? displayString(binding) : undefined,
      run: () => src.runAction(action),
    })
  }
  if (src.focused) {
    const { record, definition } = src.focused
    for (const command of definition.commands ?? []) {
      if (!(command.requires ?? []).every(src.clientHas)) continue
      out.push({
        kind: 'command',
        id: `${record.type}:${command.id}`,
        title: command.title,
        icon: isIconName(definition.icon) ? definition.icon : null,
        shortcut: command.shortcut,
        run: () => src.sendOp(record.id, command.op),
      })
    }
  }
  for (const command of src.commands) {
    out.push({ kind: 'command', id: command.id, title: command.title, icon: command.icon ?? null, run: () => { void command.run() } })
  }
  return out.filter((item) => matches(query, item.title))
}

export function workspaceItems(entries: readonly WorkspaceEntry[], currentId: string | null, query: string): WorkspaceItem[] {
  return entries
    .map((entry): WorkspaceItem => ({
      kind: 'workspace',
      id: entry.id,
      name: entry.name,
      detail: entry.kind === 'local' ? entry.root : undefined,
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
