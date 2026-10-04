// Browser views in the app (`browser.*`): a panel view whose pages follow the
// session and report what they do, as every client's pages do (10.2). The
// app's pages load a tab's URL when its `nav` moves and the change did not
// come from this client (`load` events). A load made to follow the session is
// never reported back as a navigation, only its history state, so two
// clients whose pages redirect a URL differently cannot ping-pong.

import { clientIdentity } from '@client/connections'
import { isBrowserInternalPage, type BrowserOp, type BrowserSnapshot } from '@panels/browser/contract'
import { BROWSER_NEW_TAB_URL } from '@services/browser/contract'
import type { MobileCoreMethods } from '../contract'
import type { MobileViews, PanelView, PanelViewParams } from './views'

type Params<M extends keyof MobileCoreMethods> = MobileCoreMethods[M]['params']

const loadable = (url: string) => url !== BROWSER_NEW_TAB_URL && !isBrowserInternalPage(url)

interface Follower {
  /** The last `nav` of each tab the app's page has applied. */
  seen: Map<string, number>
  /** Tabs whose page is loading a URL to follow the session. */
  following: Set<string>
}

export interface MobileBrowsers {
  open(params: PanelViewParams): void
  navigated(params: Params<'browser.navigated'>): void
  loading(params: Params<'browser.loading'>): void
  title(params: Params<'browser.title'>): void
}

export function createMobileBrowsers(views: MobileViews): MobileBrowsers {
  const followers = new WeakMap<PanelView, Follower>()

  const report = (view: PanelView, op: BrowserOp) => { void view.send(op).catch(() => { /* the panel went away */ }) }
  const find = (viewId: string) => {
    const view = views.get<BrowserSnapshot>(viewId)
    const follower = view && followers.get(view as PanelView)
    return view && follower ? { view, follower } : null
  }

  return {
    open(params) {
      const view = views.open<BrowserSnapshot>(params)
      const follower: Follower = { seen: new Map(), following: new Set() }
      followers.set(view as PanelView, follower)
      view.onSnapshot((snapshot) => {
        for (const tab of snapshot.tabs) {
          const seen = follower.seen.get(tab.id)
          follower.seen.set(tab.id, tab.nav)
          // A tab seen for the first time: the app's page opens on its URL.
          if (seen === undefined || tab.nav <= seen) continue
          if (tab.navSource === clientIdentity().clientId || !loadable(tab.url)) continue
          follower.following.add(tab.id)
          view.emit({ kind: 'load', tabId: tab.id, url: tab.url })
        }
      })
    },
    navigated({ viewId, tabId, url, title, inPage, canGoBack, canGoForward }) {
      const found = find(viewId)
      if (!found || !url || url === 'about:blank') return
      const { view, follower } = found
      report(view, follower.following.has(tabId)
        ? { kind: 'reportLoad', tabId, canGoBack, canGoForward }
        : { kind: 'reportNavigation', tabId, url, ...(inPage ? { inPage } : title ? { title } : {}), canGoBack, canGoForward })
    },
    loading({ viewId, tabId, loading, loadError }) {
      const found = find(viewId)
      if (!found) return
      if (!loading) found.follower.following.delete(tabId)
      report(found.view, { kind: 'reportLoad', tabId, loading, ...(loadError !== null ? { loadError } : {}) })
    },
    title({ viewId, tabId, title }) {
      const found = find(viewId)
      if (found && title) report(found.view, { kind: 'reportTitle', tabId, title })
    },
  }
}
