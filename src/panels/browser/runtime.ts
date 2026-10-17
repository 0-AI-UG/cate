// What the daemon's composition root needs for the browser panel: its
// definition and session class, and the `cate.browser.*` service handlers
// (`run` and `reset` from `services/browser`, `listTabs` here).

import { RpcError } from '@kernel/rpc/contract'
import type { CateServiceHandlers } from '@kernel/api/contract'
import type { browserApi } from '@services/browser/contract'
import { browserCodeHandlers, type BrowserCodeDeps } from '@services/browser/runtime'
import type { PanelId, WorkspaceDocument } from '@workspace/document/contract'
import type { PanelSession } from '@panels/framework/runtime'
import type { BrowserSnapshot } from './contract'
import definition from './definition'
import { BrowserSession, createBrowserSessionClass, type BrowserSessionDeps } from './session'

export { definition as browserDefinition, BrowserSession, createBrowserSessionClass, type BrowserSessionDeps }

/** The registry entry: `registry.register(entry.definition, entry.session)`. */
export function browserPanel(deps: BrowserSessionDeps) {
  return { definition, session: createBrowserSessionClass(deps) }
}

export interface BrowserServiceDeps extends BrowserCodeDeps {
  sessions: { session(panelId: PanelId): PanelSession | undefined }
  document: { get(): WorkspaceDocument }
}

/** The service half of `cate.browser.*`. */
export function browserServiceHandlers(deps: BrowserServiceDeps): CateServiceHandlers<typeof browserApi> {
  const browserPanels = (): PanelId[] =>
    Object.values(deps.document.get().panels).filter((record) => record.type === 'browser').map((record) => record.id)

  return {
    ...browserCodeHandlers(deps),
    listTabs: ({ panelId }) => {
      const ids = panelId ? [panelId] : browserPanels()
      const tabs = ids.flatMap((id) => {
        const session = deps.sessions.session(id)
        if (!session) return []
        const snapshot = session.snapshot() as BrowserSnapshot
        return snapshot.tabs.map(({ nav: _nav, navSource: _source, ...tab }) => ({
          ...tab,
          panelId: id,
          tabId: tab.id,
          active: tab.id === snapshot.activeTabId,
        }))
      })
      if (panelId && !deps.sessions.session(panelId)) throw new RpcError('gone', `panel ${panelId} is gone`)
      return { tabs }
    },
  }
}
