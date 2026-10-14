// Every link clicked in the desktop UI opens here: a terminal's URL and file
// links, a markdown preview's links, a URL opened with the app. A web URL
// opens where the `linkOpenTarget` setting says (asking on the first click
// and remembering the answer); the rest is client/host's `openLink`.

import { clientUi } from '@kernel/interaction'
import { openLink, type LinkTarget, type OpenLinkOptions } from '@client/host'
import { isLoopbackUrl } from '@runtime/tunnel/contract'
import { getClientSetting, setClientSetting } from '../kernel/settings'

declare module '@kernel/interaction/contract' {
  interface ClientUi {
    /** Where a clicked web link opens; the answer is remembered. */
    promptLinkOpen(url: string): Promise<'cate' | 'external' | 'cancel'>
  }
}

/** `external` forces the system browser for a web URL (Cmd/Ctrl+Shift+click). */
export async function openClickedLink(workspaceId: string, target: LinkTarget, options: OpenLinkOptions = {}): Promise<boolean> {
  if (target.kind === 'url' && !options.external && !isLoopbackUrl(target.url)) {
    let where = getClientSetting('linkOpenTarget')
    if (where === 'ask') {
      const choice = await clientUi().promptLinkOpen(target.url)
      if (choice === 'cancel') return false
      setClientSetting('linkOpenTarget', choice)
      where = choice
    }
    return openLink(workspaceId, target, { ...options, external: where === 'external' })
  }
  return openLink(workspaceId, target, options)
}
