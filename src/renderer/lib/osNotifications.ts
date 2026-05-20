// =============================================================================
// OS notifications — thin wrapper around electronAPI.notifyOS.
// No in-app state: settings-gated dispatch + a global handler for click actions.
// =============================================================================

import { useSettingsStore } from '../stores/settingsStore'
import { useAppStore, getCanvasOperations, getWorkspaceCanvasPanelId, ensureCanvasOpsForPanel } from '../stores/appStore'
import { useDockStore } from '../stores/dockStore'
import { terminalRegistry } from './terminalRegistry'
import { findTabStack, findStackContainingPanel } from '../stores/dockTreeUtils'
import { ALL_ZONES } from '../../shared/types'
import type { NotificationAction, PanelLocation } from '../../shared/types'

export function sendOsNotification(payload: {
  title: string
  body: string
  action?: NotificationAction
}): void {
  const settings = useSettingsStore.getState()
  if (!settings.notificationsEnabled) return
  if (settings.notifyOnlyWhenUnfocused && typeof document !== 'undefined' && document.hasFocus()) return
  window.electronAPI?.notifyOS(payload)
}

type DockStoreState = ReturnType<typeof useDockStore.getState>

function focusDockPanel(dock: DockStoreState, panelId: string, location: PanelLocation): void {
  if (location.type !== 'dock') return
  const zone = dock.zones[location.zone]
  if (!zone.visible) dock.toggleZone(location.zone)
  if (zone.layout) {
    const stack = findTabStack(zone.layout, location.stackId)
    if (stack) {
      const idx = stack.panelIds.indexOf(panelId)
      if (idx >= 0) dock.setActiveTab(location.stackId, idx)
    }
  }
}

function findPanelInZones(dock: DockStoreState, panelId: string): PanelLocation | null {
  for (const zoneName of ALL_ZONES) {
    const zone = dock.zones[zoneName]
    if (!zone.layout) continue
    const stack = findStackContainingPanel(zone.layout, panelId)
    if (stack) return { type: 'dock', zone: zoneName, stackId: stack.id }
  }
  return null
}

async function executeAction(action: NotificationAction): Promise<void> {
  if (action.type !== 'focusTerminal') return
  const { workspaceId, terminalId } = action

  await useAppStore.getState().selectWorkspace(workspaceId)

  // Poll briefly for the panel to become locatable (deferred restore + render settle).
  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt > 0) await new Promise<void>((r) => setTimeout(r, 50))

    const panelId = terminalRegistry.panelIdForPty(terminalId) ?? terminalId
    const dock = useDockStore.getState()

    const location = dock.getPanelLocation(panelId)
    if (location?.type === 'dock') { focusDockPanel(dock, panelId, location); return }

    const found = findPanelInZones(dock, panelId)
    if (found) { focusDockPanel(dock, panelId, found); return }

    const canvasPanelId = getWorkspaceCanvasPanelId(workspaceId)
    const ops = canvasPanelId ? ensureCanvasOpsForPanel(canvasPanelId) : getCanvasOperations()
    const nodeId = ops?.storeApi?.getState()?.nodeForPanel(panelId)
    if (nodeId) { ops!.focusPanelNode(panelId); return }
  }
}

let subscribed = false
export function subscribeToOsNotificationClicks(): void {
  if (subscribed) return
  subscribed = true
  const api = (window as any).electronAPI
  api?.onNotifyAction?.((action: NotificationAction) => { executeAction(action) })
}
