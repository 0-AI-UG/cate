// Opening a web URL for a workspace. A loopback URL names the runtime's
// machine (architecture D10, 12.3), which only a loopback-routed webview
// reaches, so it opens in the workspace's panel type that opens URLs and never
// in the client's system browser, for every workspace alike.

import { clientUi } from '@kernel/interaction'
import { isLoopbackUrl } from '@runtime/tunnel/contract'
import type { PanelId } from '@workspace/document/contract'
import { createPanel } from './createPanel'
import { panelTypeOpening } from './definitions'

/** Opens `url` in a new panel of the workspace that opens URLs, next to
 *  `near` when given. False when no workspace or no such panel type. */
export function openUrlInPanel(workspaceId: string | null | undefined, url: string, near?: PanelId): boolean {
  const type = panelTypeOpening('url')
  return !!workspaceId && !!type && createPanel(workspaceId, type, near ? { url, near } : { url }) !== null
}

/** A loopback URL opens in a panel of the workspace; any other URL in the
 *  client's system browser. */
export function openUrlFor(workspaceId: string | null | undefined, url: string, near?: PanelId): void {
  if (isLoopbackUrl(url)) openUrlInPanel(workspaceId, url, near)
  else clientUi().openExternal(url)
}
