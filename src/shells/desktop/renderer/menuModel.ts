// The native menu bar, generated from the declared actions: each action with
// a `menu` placement goes into its menu's group (the shared skeleton orders
// groups and roles), with its current key. Rebuilt and sent to main whenever
// actions or bindings change.

import { declaredActions, shortcutRegistry, subscribeShortcuts, type DeclaredAction } from '@kernel/interaction'
import { MENU_BAR, type ActionId, type StoredShortcut } from '@kernel/interaction/contract'
import { actionSupported, subscribeActions } from '@client/host'
import { MENU_SKELETON, type DesktopApi, type MenuModel, type MenuModelItem, type MenuModelMenu } from '../contract'

function actionItem({ id, spec }: DeclaredAction, shortcut: StoredShortcut | undefined): MenuModelItem {
  return {
    type: 'action',
    action: id,
    label: spec.title,
    ...(shortcut?.key ? { shortcut } : {}),
    registerShortcut: !spec.keys?.windowOnly,
  }
}

/** One group's items in order; items naming a submenu are gathered into it. */
function groupItems(actions: DeclaredAction[], shortcuts: Readonly<Record<ActionId, StoredShortcut>>): MenuModelItem[] {
  const sorted = [...actions].sort((a, b) => (a.spec.menu!.order ?? 0) - (b.spec.menu!.order ?? 0))
  const items: MenuModelItem[] = []
  const submenus = new Map<string, MenuModelItem[]>()
  for (const action of sorted) {
    const submenu = action.spec.menu!.submenu
    const item = actionItem(action, shortcuts[action.id])
    if (!submenu) { items.push(item); continue }
    let list = submenus.get(submenu)
    if (!list) {
      list = []
      submenus.set(submenu, list)
      items.push({ type: 'submenu', label: submenu, items: list })
    }
    list.push(item)
  }
  return items
}

export function buildMenuModel(): MenuModel {
  const shortcuts = shortcutRegistry().resolved()
  const supported = declaredActions().filter(({ id }) => actionSupported(id))
  const placed = new Set<ActionId>()
  const bar: MenuModelMenu[] = MENU_BAR.map((menuId) => {
    const skeleton = MENU_SKELETON[menuId]
    const byGroup = new Map<string, DeclaredAction[]>()
    for (const action of supported) {
      if (action.spec.menu?.bar !== menuId) continue
      placed.add(action.id)
      const list = byGroup.get(action.spec.menu.group) ?? []
      list.push(action)
      byGroup.set(action.spec.menu.group, list)
    }
    const named = new Set(skeleton.blocks.flat().flatMap((entry) => ('group' in entry ? [entry.group] : [])))
    const blocks = [
      ...skeleton.blocks.map((block) => block.flatMap((entry): MenuModelItem[] =>
        'role' in entry ? [{ type: 'role', role: entry.role }] : groupItems(byGroup.get(entry.group) ?? [], shortcuts))),
      ...[...byGroup].filter(([group]) => !named.has(group)).map(([, actions]) => groupItems(actions, shortcuts)),
    ].filter((block) => block.length > 0)
    return {
      id: menuId,
      label: skeleton.label,
      items: blocks.flatMap((block, i): MenuModelItem[] => (i === 0 ? block : [{ type: 'separator' }, ...block])),
    }
  }).filter((menu) => menu.items.length > 0)

  const hidden: MenuModel['hidden'] = []
  const guestKeys: MenuModel['guestKeys'] = []
  for (const { id, spec } of supported) {
    const shortcut = shortcuts[id]
    if (shortcut?.key && !spec.keys?.windowOnly && !placed.has(id)) hidden.push({ action: id, label: spec.title, shortcut })
    for (const alias of spec.aliasKeys ?? []) hidden.push({ action: id, label: spec.title, shortcut: alias })
    if (shortcut?.key && spec.keys?.fromGuests) guestKeys.push({ action: id, shortcut })
  }
  return { bar, hidden, guestKeys }
}

/** Keeps main's menu bar in step with this window's actions; returns the
 *  undo. */
export function syncMenuModel(api: DesktopApi): () => void {
  let queued = false
  const push = () => {
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      void api.menu.setModel(buildMenuModel())
    })
  }
  const stops = [subscribeActions(push), subscribeShortcuts(push)]
  push()
  return () => { for (const stop of stops) stop() }
}
