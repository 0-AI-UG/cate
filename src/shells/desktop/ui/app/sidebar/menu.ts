// Context menus of the sidebar. The desktop shell shows them natively; a shell
// without menus gets none (the same actions are in the command palette and
// the settings window).

import { desktopPort, type MenuItem } from '../desktop'

export type { MenuItem }

export async function showMenu(items: MenuItem[]): Promise<string | null> {
  const port = desktopPort()
  if (!port) return null
  return port.showContextMenu(items)
}
