import type { PanelType } from '../../../shared/types'
import { collectPanelIds } from '../../../shared/collectPanelIds'
import { useAppStore } from '../../stores/appStore'

/** True when `panelId` is a container whose layout directly hosts a panel of `type`. */
export function containerHoldsType(panelId: string, type: PanelType): boolean {
  for (const ws of useAppStore.getState().workspaces) {
    const panel = ws.panels[panelId]
    if (!panel) continue
    return panel.type === 'container'
      && collectPanelIds(panel.containerLayout).some((id) => ws.panels[id]?.type === type)
  }
  return false
}
