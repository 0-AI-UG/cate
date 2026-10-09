// Loading the harness UI. The page stays at `http://127.0.0.1:<port>` on the
// runtime's machine; the shell's per-workspace web proxy routes loopback
// hosts through the connection (architecture 12.3), so nothing here knows
// the transport. Before the page loads, T3's session cookie is installed in
// the workspace's partition.

import type { T3PanelTarget } from '../contract'

/** What a shell with `webview` provides to host harness pages. */
export interface T3WebviewHost {
  /** The workspace's partition, routed through its loopback proxy and shared
   *  by its browser and chat panels. */
  partition(workspaceId: string): string
  /** Sets `cookie` for `url` in `partition`. */
  setCookie(partition: string, url: string, cookie: { name: string; value: string }): Promise<void>
}

let host: T3WebviewHost | null = null

export function installT3WebviewHost(next: T3WebviewHost | null): () => void {
  const previous = host
  host = next
  return () => { if (host === next) host = previous }
}

export function t3WebviewHost(): T3WebviewHost {
  if (!host) throw new Error('No webview host installed')
  return host
}

/** Installs the harness session cookie; resolves with the partition to load
 *  `target.url` in. */
export async function prepareT3Page(workspaceId: string, target: Pick<T3PanelTarget, 'url' | 'session'>): Promise<{ partition: string }> {
  const webviews = t3WebviewHost()
  const partition = webviews.partition(workspaceId)
  await webviews.setCookie(partition, new URL(target.url).origin, target.session)
  return { partition }
}
