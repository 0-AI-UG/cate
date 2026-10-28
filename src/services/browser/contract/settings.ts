import { defineSettings, oneOf, setting } from '@kernel/settings/contract/define'

export type BrowserSearchEngine = 'google' | 'duckDuckGo' | 'bing' | 'brave'
export type BrowserNewTabBehavior = 'startPage' | 'homepage'
/** Where a clicked web link opens: Cate's browser panel or the system
 *  browser (`ask`: the first click asks and remembers). */
export type LinkOpenTarget = 'ask' | 'cate' | 'external'

export const browserClientSettings = defineSettings({
  scope: 'client',
  keys: {
    /** The client's own upstream proxy (may hold credentials); empty uses the
     *  system proxy when the connection permits native browser networking. */
    browserProxyUrl: setting(''),
    /** A loopback URL always opens in Cate; Cmd/Ctrl+Shift+click in a
     *  terminal always opens outside. */
    linkOpenTarget: setting<LinkOpenTarget>('ask', oneOf('ask', 'cate', 'external')),
  },
})

export const browserSettings = defineSettings({
  scope: 'workspace',
  keys: {
    browserHomepage: setting(''),
    browserSearchEngine: setting<BrowserSearchEngine>('google', oneOf('google', 'duckDuckGo', 'bing', 'brave')),
    browserNewTabBehavior: setting<BrowserNewTabBehavior>('startPage', oneOf('startPage', 'homepage')),
  },
})
