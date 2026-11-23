// Context menus go through the ClientUi port. The shell draws the menu and
// the toolbar exposes the same actions.

import { clientUi } from '@kernel/interaction'
import type { ContextMenuItem } from '@kernel/interaction/contract'

export type { ContextMenuItem }

export async function showContextMenu(items: ContextMenuItem[]): Promise<string | null> {
  try {
    return (await clientUi().showContextMenu?.(items)) ?? null
  } catch {
    return null
  }
}
