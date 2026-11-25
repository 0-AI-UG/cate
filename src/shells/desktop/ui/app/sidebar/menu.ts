// Context menus of the sidebar, drawn in the app like every other menu.

import { showContextMenu } from '../../kernel/interaction'
import type { MenuItem } from '../desktop'

export type { MenuItem }

export const showMenu = (items: MenuItem[]): Promise<string | null> => showContextMenu(items)
