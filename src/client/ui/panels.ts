// Icons for panel rows, from the definitions client/host holds.

import { isIconName, type IconName } from '@kernel/ui/contract'
import { panelDefinition } from '@client/host'

/** The icon name for a panel type, with a neutral fallback. */
export function panelIcon(type: string): IconName {
  const icon = panelDefinition(type)?.icon
  return isIconName(icon) ? icon : 'grid'
}
