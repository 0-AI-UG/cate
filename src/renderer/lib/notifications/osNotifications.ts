// =============================================================================
// OS notifications — thin wrapper around electronAPI.notifyOS.
// No in-app state: settings-gated dispatch + a global handler for click actions.
// =============================================================================

import { terminalRegistry } from '../terminal/terminalRegistry'
import { revealPanel } from '../workspace/panelReveal'
import type { NotificationAction } from '../../../shared/types'

async function executeAction(action: NotificationAction): Promise<void> {
  if (action.type !== 'focusTerminal') return
  const { workspaceId, terminalId } = action

  const panelId = terminalRegistry.panelIdForPty(terminalId) ?? terminalId
  // retry: the panel may not be locatable until a deferred restore + render
  // settle completes after the workspace switch.
  await revealPanel(workspaceId, panelId, { retry: true })
}

let subscribed = false
export function subscribeToOsNotificationClicks(): void {
  if (subscribed) return
  subscribed = true
  const api = (window as any).electronAPI
  api?.onNotifyAction?.((action: NotificationAction) => { executeAction(action) })
}
