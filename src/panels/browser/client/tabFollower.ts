// How every client's browser pages follow the session (10.2): a page loads a
// tab's URL when its `nav` moves and the change did not come from this
// client. A load made to follow the session is never reported back as a
// navigation, only its history state, so two clients whose pages redirect a
// URL differently cannot ping-pong.

import { BROWSER_NEW_TAB_URL } from '@services/browser/contract'
import { isBrowserInternalPage, type BrowserOp, type BrowserSnapshot } from '../contract'

/** A URL a page can load (not the start page or an internal page). */
export const loadableTabUrl = (url: string): boolean => url !== BROWSER_NEW_TAB_URL && !isBrowserInternalPage(url)

/** What a page reports after a navigation. */
export interface TabNavigation {
  url: string
  title?: string
  inPage?: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export interface BrowserTabFollower {
  /** The tabs whose page should load a URL another client navigated to; each
   *  counts as following until `loadEnded`. A tab seen for the first time
   *  loads nothing: its page opens on its URL. */
  toFollow(snapshot: BrowserSnapshot): { tabId: string; url: string }[]
  /** The last `nav` of a tab this client has applied. */
  seenNav(tabId: string): number | undefined
  /** The op reporting a page's navigation. */
  report(tabId: string, navigation: TabNavigation): BrowserOp
  /** A tab's load ended (or its page went): it no longer follows. */
  loadEnded(tabId: string): void
  isFollowing(tabId: string): boolean
}

export function createBrowserTabFollower(ownClientId: () => string): BrowserTabFollower {
  const seen = new Map<string, number>()
  const following = new Set<string>()
  return {
    toFollow(snapshot) {
      const out: { tabId: string; url: string }[] = []
      for (const tab of snapshot.tabs) {
        const last = seen.get(tab.id)
        seen.set(tab.id, Math.max(last ?? tab.nav, tab.nav))
        if (last === undefined || tab.nav <= last) continue
        if (tab.navSource === ownClientId() || !loadableTabUrl(tab.url)) continue
        following.add(tab.id)
        out.push({ tabId: tab.id, url: tab.url })
      }
      return out
    },
    seenNav: (tabId) => seen.get(tabId),
    report(tabId, { url, title, inPage, canGoBack, canGoForward }) {
      return following.has(tabId)
        ? { kind: 'reportLoad', tabId, canGoBack, canGoForward }
        : { kind: 'reportNavigation', tabId, url, ...(inPage ? { inPage } : title ? { title } : {}), canGoBack, canGoForward }
    },
    loadEnded(tabId) { following.delete(tabId) },
    isFollowing: (tabId) => following.has(tabId),
  }
}
