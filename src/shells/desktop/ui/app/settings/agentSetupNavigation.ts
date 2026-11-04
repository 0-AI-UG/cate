import { revealPanel } from '@client/host'
import { useUIStore } from '../state/uiStore'

/** Native setup can ask for a device code in its terminal. Reveal it before
 * dismissing Settings; a missing terminal leaves the setup controls available. */
export async function openAgentSetupTerminal(workspaceId: string, panelId: string): Promise<boolean> {
  const revealed = await revealPanel(workspaceId, panelId, { retry: true })
  if (revealed && useUIStore.getState().overlay?.view === 'settings') useUIStore.getState().closeOverlay()
  return revealed
}
