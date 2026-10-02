// Creation menus: the "New <type>" entries every creation surface shows,
// generated from the definitions, with a worktree submenu for types created
// in a checkout (`creation.inWorktree`) when the workspace has several.

import type { ContextMenuItem } from '@kernel/ui/contract'
import type { AnyPanelDefinition } from '@panels/framework/contract'
import type { WorktreeId, WorktreeMeta } from '@workspace/document/contract'

export interface WorktreeChoice {
  id: string
  path: string
  label: string
}

/** The ready checkouts a new panel can be created in; the first is the
 *  primary. */
export function worktreeChoices(worktrees: Readonly<Record<WorktreeId, WorktreeMeta>> | undefined): WorktreeChoice[] {
  return Object.values(worktrees ?? {})
    .filter((worktree) => worktree.status === 'ready')
    .map((worktree, i) => ({
      id: worktree.id,
      path: worktree.path,
      label: (worktree.label || worktree.path.split(/[\\/]/).pop() || worktree.path) + (i === 0 ? ' (primary)' : ''),
    }))
}

/** What a picked creation entry creates: the type and, for a worktree pick,
 *  the create options binding it to that checkout. */
export interface CreationPick {
  type: string
  options: { worktreeId?: string; cwd?: string }
}

const PREFIX = 'new:'

/** Menu entries for `definitions`, ids parsed by `creationPick`. */
export function creationMenuItems(
  definitions: readonly AnyPanelDefinition[],
  worktrees: readonly WorktreeChoice[],
  label: (definition: AnyPanelDefinition) => string = (definition) => definition.creation?.title ?? `New ${definition.label}`,
): ContextMenuItem[] {
  return definitions.map((definition) => definition.creation?.inWorktree && worktrees.length > 1
    ? {
      label: label(definition),
      submenu: worktrees.map((worktree) => ({ id: `${PREFIX}${definition.type}:${worktree.id}`, label: worktree.label })),
    }
    : { id: `${PREFIX}${definition.type}`, label: label(definition) })
}

/** The creation a menu id from `creationMenuItems` names, or null. */
export function creationPick(id: string | null, worktrees: readonly WorktreeChoice[]): CreationPick | null {
  if (!id?.startsWith(PREFIX)) return null
  const [type, worktreeId] = id.slice(PREFIX.length).split(':')
  const worktree = worktreeId ? worktrees.find((w) => w.id === worktreeId) : undefined
  return { type, options: worktree ? { worktreeId: worktree.id, cwd: worktree.path } : {} }
}
