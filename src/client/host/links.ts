// Opening a clicked link, wherever it was clicked (a terminal, a markdown
// preview, a URL opened with the app). A web URL opens in the workspace's
// panel type that opens URLs, or in the client's system browser when asked
// to; a loopback URL names the runtime's machine (architecture D10, 12.3),
// which only a loopback-routed webview reaches, so it never leaves Cate. A
// file opens in the panel already showing it, else in a new panel of the type
// that opens files. A new panel is placed from the panel the link was clicked
// in (`createPanelFrom`). A clicked web link opens where this client's
// `linkOpenTarget` setting says, asking on the first click and remembering
// the answer (`openClickedLink`).

import { clientUi } from '@kernel/interaction'
import { tryRuntimeFor } from '@kernel/rpc/client'
import { isLoopbackUrl } from '@runtime/tunnel/contract'
import type { LinkOpenTarget } from '@services/browser/contract'
import type { PanelId } from '@workspace/document/contract'
import { documentStoreFor } from '@client/document'
import { panelDefinition, panelTypeOpening } from './definitions'
import { createPanelFrom } from './panelTargetPicker'
import { revealPanel } from './reveal'

declare module '@kernel/interaction/contract' {
  interface ClientUi {
    /** Where a clicked web link opens; the answer is remembered. */
    promptLinkOpen(url: string): Promise<'cate' | 'external' | 'cancel'>
  }
}

/** The slice of the client settings store link opening uses
 *  (`ClientSettingsStore` from kernel/settings satisfies it). */
export interface LinkSettings {
  get(key: 'linkOpenTarget'): LinkOpenTarget
  set(key: 'linkOpenTarget', value: LinkOpenTarget): unknown
}

let linkSettings: LinkSettings | null = null

/** The shell installs its client settings store at start. Without one every
 *  clicked web link asks. */
export function installLinkSettings(next: LinkSettings | null): void {
  linkSettings = next
}

export type LinkTarget =
  | { kind: 'url'; url: string }
  /** An absolute path; `line` and `column` are 1-based. */
  | { kind: 'file'; path: string; line?: number; column?: number }

export interface OpenLinkOptions {
  /** The panel the link was clicked in: a new panel is placed from it. */
  from?: PanelId
  /** A web URL opens in the system browser (a loopback URL still does not). */
  external?: boolean
}

/** False when nothing opened (no panel type for it, or the person cancelled
 *  the placement). */
export async function openLink(workspaceId: string, target: LinkTarget, options: OpenLinkOptions = {}): Promise<boolean> {
  if (target.kind === 'url') {
    const type = panelTypeOpening('url')
    const loopback = isLoopbackUrl(target.url)
    if (!loopback && (options.external || !type)) {
      clientUi().openExternal(target.url)
      return true
    }
    return !!type && await createPanelFrom(workspaceId, options.from, type, { url: target.url }) !== null
  }
  const type = panelTypeOpening('file')
  if (!type) return false
  const existing = panelShowingFile(workspaceId, type, target.path)
  const panelId = existing ?? await createPanelFrom(workspaceId, options.from, type, { filePath: target.path })
  if (!panelId) return false
  if (existing) void revealPanel(workspaceId, existing)
  if (target.line !== undefined) {
    // The `opens: ['file']` session contract: `openFile {path, line?, column?}`.
    const op = { kind: 'openFile', path: target.path, line: target.line, column: target.column ?? 1 }
    void tryRuntimeFor(workspaceId)?.session.op({ panelId, op }).catch(() => {})
  }
  return true
}

/** A link the person clicked or tapped: a web URL opens where the
 *  `linkOpenTarget` setting says (asking the first time and remembering);
 *  `external` forces the system browser (Cmd/Ctrl+Shift+click). False when
 *  nothing opened. */
export async function openClickedLink(workspaceId: string, target: LinkTarget, options: OpenLinkOptions = {}): Promise<boolean> {
  if (target.kind === 'url' && !options.external && !isLoopbackUrl(target.url)) {
    let where = linkSettings?.get('linkOpenTarget') ?? 'ask'
    if (where === 'ask') {
      const choice = await clientUi().promptLinkOpen(target.url)
      if (choice === 'cancel') return false
      linkSettings?.set('linkOpenTarget', choice)
      where = choice
    }
    return openLink(workspaceId, target, { ...options, external: where === 'external' })
  }
  return openLink(workspaceId, target, options)
}

/** The panel of `type` already working on `path`, if any. */
export function panelShowingFile(workspaceId: string, type: string, path: string): PanelId | null {
  const doc = documentStoreFor(workspaceId)?.getSnapshot()
  const checkout = panelDefinition(type)?.checkoutPath
  if (!doc || !checkout) return null
  return Object.values(doc.panels).find((panel) => panel.type === type && checkout(panel) === path)?.id ?? null
}
