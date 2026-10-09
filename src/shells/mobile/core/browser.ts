// Browser views in the app (`browser.*`): a panel view whose pages follow the
// session (the core's tab follower: `load` events) and report what they do,
// as every client's pages do (10.2).

import { clientIdentity } from '@client/connections'
import { createBrowserTabFollower, type BrowserTabFollower } from '@panels/browser/client'
import type { BrowserOp, BrowserSnapshot } from '@panels/browser/contract'
import type { MobileCoreMethods } from '../contract'
import type { MobileViews, PanelView, PanelViewParams } from './views'

type Params<M extends keyof MobileCoreMethods> = MobileCoreMethods[M]['params']

export interface MobileBrowsers {
  open(params: PanelViewParams): void
  navigated(params: Params<'browser.navigated'>): void
  loading(params: Params<'browser.loading'>): void
  title(params: Params<'browser.title'>): void
}

export function createMobileBrowsers(views: MobileViews): MobileBrowsers {
  const followers = new WeakMap<PanelView, BrowserTabFollower>()

  const report = (view: PanelView, op: BrowserOp) => { void view.send(op).catch(() => { /* the panel went away */ }) }
  const find = (viewId: string) => {
    const view = views.get<BrowserSnapshot>(viewId)
    const follower = view && followers.get(view as PanelView)
    return view && follower ? { view, follower } : null
  }

  return {
    open(params) {
      const view = views.open<BrowserSnapshot>(params)
      const follower = createBrowserTabFollower(() => clientIdentity().clientId)
      followers.set(view as PanelView, follower)
      view.onSnapshot((snapshot) => {
        for (const { tabId, url } of follower.toFollow(snapshot)) view.emit({ kind: 'load', tabId, url })
      })
    },
    navigated({ viewId, tabId, url, title, inPage, canGoBack, canGoForward }) {
      const found = find(viewId)
      if (!found || !url || url === 'about:blank') return
      report(found.view, found.follower.report(tabId, { url, title: title ?? undefined, inPage, canGoBack, canGoForward }))
    },
    loading({ viewId, tabId, loading, loadError }) {
      const found = find(viewId)
      if (!found) return
      if (!loading) found.follower.loadEnded(tabId)
      report(found.view, { kind: 'reportLoad', tabId, loading, ...(loadError !== null ? { loadError } : {}) })
    },
    title({ viewId, tabId, title }) {
      const found = find(viewId)
      if (found && title) report(found.view, { kind: 'reportTitle', tabId, title })
    },
  }
}
