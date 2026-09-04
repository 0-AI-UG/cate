// =============================================================================
// terminalUrlOpen
//
// Routes a terminal URL into an in-app browser panel. Used when a user
// Cmd/Ctrl+clicks a link in a terminal (see terminalLinks + terminalRegistry).
//
//   - Reuses an unambiguous browser session in the same workspace. Only creates
//     a new panel when none exists.
// =============================================================================

import { useAppStore } from '../../stores/appStore'
import { findBrowserPanelId, handleBrowserMethod } from '../browser/browserDriver'

/** Open a URL on the canvas: reuse the workspace's browser panel if one exists,
 *  otherwise create a new one. */
export function openTerminalUrl(workspaceId: string, url: string): void {
  const existing = findBrowserPanelId(workspaceId)
  if (existing) {
    void handleBrowserMethod(workspaceId, 'cate.browser.open', { panelId: existing, url })
    return
  }
  useAppStore.getState().createBrowser(workspaceId, url)
}
