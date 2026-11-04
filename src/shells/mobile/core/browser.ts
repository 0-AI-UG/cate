// Browser views in the app (`browser.*`): a panel view whose pages follow the
// session (the core's tab follower: `load` events) and report what they do,
// as every client's pages do (10.2).

import { runtimeFor } from '@kernel/rpc/client'
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
  passwordSuggestions(params: Params<'browser.passwordSuggestions'>): Promise<MobileCoreMethods['browser.passwordSuggestions']['result']>
  passwordForFill(params: Params<'browser.passwordForFill'>): Promise<MobileCoreMethods['browser.passwordForFill']['result']>
  passwordSaveDisposition(params: Params<'browser.passwordSaveDisposition'>): Promise<MobileCoreMethods['browser.passwordSaveDisposition']['result']>
  savePassword(params: Params<'browser.savePassword'>): Promise<MobileCoreMethods['browser.savePassword']['result']>
}

export function createMobileBrowsers(views: MobileViews): MobileBrowsers {
  const followers = new WeakMap<PanelView, BrowserTabFollower>()

  const report = (view: PanelView, op: BrowserOp) => { void view.send(op).catch(() => { /* the panel went away */ }) }
  const find = (viewId: string) => {
    const view = views.get<BrowserSnapshot>(viewId)
    const follower = view && followers.get(view as PanelView)
    return view && follower ? { view, follower } : null
  }

  const dataFor = (viewId: string, tabId: string) => {
    const found = find(viewId)
    if (!found?.view.snapshot()?.tabs.some((tab) => tab.id === tabId)) throw new Error('The browser tab is not open.')
    return runtimeFor(found.view.workspaceId).browserData
  }

  return {
    passwordSuggestions: ({ viewId, tabId, url }) => dataFor(viewId, tabId).passwordSuggestions({ url }),
    passwordForFill: ({ viewId, tabId, url, id }) => dataFor(viewId, tabId).passwordForFill({ url, id }),
    passwordSaveDisposition: ({ viewId, tabId, input }) => dataFor(viewId, tabId).passwordSaveDisposition({ input }),
    savePassword: ({ viewId, tabId, input }) => dataFor(viewId, tabId).savePassword({ input }),
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
      const op = found?.follower.report(tabId, { url, title: title ?? undefined, inPage, canGoBack, canGoForward })
      if (found && op) report(found.view, op)
    },
    loading({ viewId, tabId, loading, loadError }) {
      const found = find(viewId)
      if (found) report(found.view, found.follower.load(tabId, { loading, ...(loadError !== null ? { loadError } : {}) }))
    },
    title({ viewId, tabId, title }) {
      const found = find(viewId)
      if (found && title) report(found.view, { kind: 'reportTitle', tabId, title })
    },
  }
}
