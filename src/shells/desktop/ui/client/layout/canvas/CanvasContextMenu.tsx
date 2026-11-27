// The menu a right click on empty canvas opens, drawn in the app: "Add" with
// the creatable panel types in creation order (a type some module offers more
// ways to create, the agents for a terminal, opens a submenu: its plain "New
// <label>" first, then those), then the actions declared for the canvas menu.
// Nothing here names a type or an action. Every block lands with its top-left
// at the canvas point captured when the menu opened, whatever the zoom, and is
// focused there without moving the view.

import { useEffect, useMemo, useReducer, type ReactNode } from 'react'
import { Plus } from 'lucide-react'
import { declaredActions } from '@kernel/interaction'
import { isIconName } from '@kernel/interaction/contract'
import type { AnyPanelDefinition } from '@panels/framework/contract'
import type { Point } from '@workspace/canvas/contract'
import { canRunAction, runAction, type WorktreeChoice } from '@client/host'
import { CascadingMenu, Icon, type CascadingMenuItem } from '../../../kernel/interaction'
import { canvasHost } from './ports'
import { createPanelOnCanvas } from './actions'
import { allSpawnMenus, spawnMenuFor, type SpawnMenuEntry } from './toolbarItems'

export interface CanvasContextMenuProps {
  workspaceId: string
  canvasId: string
  /** Window point of the right click. */
  x: number
  y: number
  /** The canvas point under it, taken at the click. */
  canvasPoint: Point
  worktrees: readonly WorktreeChoice[]
  onClose(): void
}

const definitionIcon = (definition: AnyPanelDefinition) =>
  isIconName(definition.icon) ? <Icon name={definition.icon} size={15} /> : undefined

const creationTitle = (definition: AnyPanelDefinition): string =>
  definition.creation?.title ?? `New ${definition.label}`

/** The canvas context menu's items: pure over its inputs, so it is tested
 *  without a canvas. `create` makes a panel of a type at the click point,
 *  `spawn` runs a spawn entry there. */
export function canvasMenuItems({ definitions, worktrees, spawnEntries, actions, create, spawn, run }: {
  definitions: readonly AnyPanelDefinition[]
  worktrees: readonly WorktreeChoice[]
  /** A type's spawn entries, or null when no module offers any for it. */
  spawnEntries: (type: string) => readonly SpawnMenuEntry[] | null
  actions: readonly { id: string; title: string }[]
  create: (type: string, checkout: { worktreeId?: string; cwd?: string }) => void
  spawn: (entry: SpawnMenuEntry, worktreeId?: string) => void
  run: (actionId: string) => void
}): CascadingMenuItem[] {
  const several = worktrees.length > 1
  // In a checkout: once per ready worktree when there are several.
  const inWorktrees = (definition: AnyPanelDefinition, id: string, label: string, icon: ReactNode, make: (worktree?: WorktreeChoice) => void): CascadingMenuItem =>
    definition.creation?.inWorktree && several
      ? { id, label, icon, submenu: worktrees.map((worktree) => ({ id: `${id}:${worktree.id}`, label: worktree.label, onSelect: () => make(worktree) })) }
      : { id, label, icon, onSelect: () => make() }

  const add: CascadingMenuItem[] = definitions.map((definition) => {
    const make = (worktree?: WorktreeChoice) => create(definition.type, worktree ? { worktreeId: worktree.id, cwd: worktree.path } : {})
    const entries = spawnEntries(definition.type)
    if (!entries) return inWorktrees(definition, `new:${definition.type}`, definition.label, definitionIcon(definition), make)
    return {
      id: `type:${definition.type}`,
      label: definition.label,
      icon: definitionIcon(definition),
      submenu: [
        inWorktrees(definition, `new:${definition.type}`, creationTitle(definition), undefined, make),
        ...(entries.length > 0 ? [{ type: 'separator' as const }] : []),
        ...entries.map((entry) => inWorktrees(definition, `spawn:${definition.type}:${entry.id}`, entry.label, entry.icon, (worktree) => spawn(entry, worktree?.id))),
      ],
    }
  })

  return [
    { id: 'add', label: 'Add', icon: <Plus size={15} />, submenu: add, disabled: add.length === 0 },
    ...(actions.length > 0 ? [{ type: 'separator' as const }] : []),
    ...actions.map((action) => ({ id: `action:${action.id}`, label: action.title, onSelect: () => run(action.id) })),
  ]
}

export function CanvasContextMenu({ workspaceId, canvasId, x, y, canvasPoint, worktrees, onClose }: CanvasContextMenuProps): JSX.Element {
  // Spawn entries arrive and change while the menu is open (agents found).
  const [version, refresh] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    const stops = allSpawnMenus().map((menu) => menu.watch(workspaceId, refresh))
    return () => { for (const stop of stops) stop() }
  }, [workspaceId])

  const items = useMemo(() => {
    const context = { workspaceId, canvasId }
    const position = { x: canvasPoint.x, y: canvasPoint.y }
    return canvasMenuItems({
      definitions: canvasHost().creatable(),
      worktrees,
      spawnEntries: (type) => spawnMenuFor(type)?.entries(workspaceId) ?? null,
      actions: declaredActions()
        .filter(({ id, spec }) => spec.contextMenus?.includes('canvas') && canRunAction(id, context))
        .map(({ id, spec }) => ({ id, title: spec.title })),
      create: (type, checkout) => {
        createPanelOnCanvas(workspaceId, canvasId, type, { position, exact: true, center: false, ...checkout })
      },
      spawn: (entry, worktreeId) => entry.create({ workspaceId, canvasId, position, ...(worktreeId ? { worktreeId } : {}) }),
      run: (actionId) => { void runAction(actionId, context) },
    })
    // `version` re-reads the spawn entries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, canvasId, canvasPoint.x, canvasPoint.y, worktrees, version])

  return <CascadingMenu x={x} y={y} items={items} onClose={onClose} ariaLabel="Canvas" />
}
