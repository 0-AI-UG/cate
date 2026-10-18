// What the daemon's composition root needs for the browser panel: its
// definition and session class, and the `cate.browser.*` service handler
// (`listTabs`).

import { RpcError } from '@kernel/rpc/contract'
import type { CateServiceHandlers } from '@kernel/api/contract'
import type { browserApi } from '@services/browser/contract'
import type { PanelId, WorkspaceDocument } from '@workspace/document/contract'
import type { PanelSession } from '@panels/framework/runtime'
import type { BrowserSnapshot, BrowserTabOpener } from './contract'
import definition from './definition'
import { BrowserSession, createBrowserSessionClass, type BrowserSessionDeps } from './session'

export { definition as browserDefinition, BrowserSession, createBrowserSessionClass, type BrowserSessionDeps }

/** The registry entry: `registry.register(entry.definition, entry.session)`. */
export function browserPanel(deps: BrowserSessionDeps) {
  return { definition, session: createBrowserSessionClass(deps) }
}

export interface BrowserServiceDeps {
  sessions: { session(panelId: PanelId): PanelSession | undefined }
  document: { get(): WorkspaceDocument }
}

/** Who opened a tab, as the caller reads it. */
function openerOf(opener: BrowserTabOpener, caller: string): string {
  if (!opener) return 'person'
  if ('page' in opener) return `page in ${opener.page}`
  return opener.caller === caller ? 'you' : 'agent'
}

/** The service half of `cate.browser.*`. */
export function browserServiceHandlers(deps: BrowserServiceDeps): CateServiceHandlers<typeof browserApi> {
  const browserPanels = (): PanelId[] =>
    Object.values(deps.document.get().panels).filter((record) => record.type === 'browser').map((record) => record.id)

  return {
    listTabs: ({ panelId }, ctx) => {
      const ids = panelId ? [panelId] : browserPanels()
      const tabs = ids.flatMap((id) => {
        const session = deps.sessions.session(id)
        if (!session) return []
        const snapshot = session.snapshot() as BrowserSnapshot
        return snapshot.tabs.map(({ nav: _nav, navSource: _source, openedBy, ...tab }) => ({
          ...tab,
          panelId: id,
          tabId: tab.id,
          active: tab.id === snapshot.activeTabId,
          opener: openerOf(openedBy, ctx.caller.id),
        }))
      })
      if (panelId && !deps.sessions.session(panelId)) throw new RpcError('gone', `panel ${panelId} is gone`)
      return { tabs }
    },
  }
}
