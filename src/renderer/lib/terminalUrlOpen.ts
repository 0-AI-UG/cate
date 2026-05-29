// =============================================================================
// terminalUrlOpen
//
// Routes a terminal URL into an in-app browser panel. Used when a user
// Cmd/Ctrl+clicks a link in a terminal (see terminalLinks + terminalRegistry).
//
//   - Reuses an existing browser panel in the same workspace by calling
//     loadURL on its <webview>. Only creates a new panel when none exists.
// =============================================================================

import { useAppStore } from '../stores/appStore'
import { portalRegistry } from './portalRegistry'

function findBrowserPanelId(workspaceId: string): string | null {
  const ws = useAppStore.getState().workspaces.find((w) => w.id === workspaceId)
  if (!ws) return null
  for (const panel of Object.values(ws.panels)) {
    if (panel.type === 'browser') return panel.id
  }
  return null
}

/** Open a URL on the canvas: reuse the workspace's browser panel if one exists,
 *  otherwise create a new one. */
export function openTerminalUrl(workspaceId: string, url: string): void {
  const existing = findBrowserPanelId(workspaceId)
  if (existing) {
    const webview = portalRegistry.get(existing)
    if (webview) {
      try {
        webview.loadURL(url)
        useAppStore.getState().updatePanelUrl(workspaceId, existing, url)
        return
      } catch {
        // Fall through if the guest webContents is not dom-ready yet.
      }
    }
    // Browser panel exists but webview is not registered yet — still prefer
    // updating its URL so it picks it up on next mount.
    useAppStore.getState().updatePanelUrl(workspaceId, existing, url)
    return
  }
  useAppStore.getState().createBrowser(workspaceId, url)
}
