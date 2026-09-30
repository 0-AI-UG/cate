// Native context menus are a ClientUi port: a desktop shell shows an OS
// menu; a client without one gets no menu (the same actions stay in the
// toolbar).

import { clientUi } from '@kernel/ui'
import type { ContextMenuItem } from '@kernel/ui/contract'

export type { ContextMenuItem }

export async function showContextMenu(items: ContextMenuItem[]): Promise<string | null> {
  try {
    return (await clientUi().showContextMenu?.(items)) ?? null
  } catch {
    return null
  }
}
