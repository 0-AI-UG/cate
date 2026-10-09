import { defineSettings, oneOf, setting } from '@kernel/settings/contract/define'

export type BrowserSearchEngine = 'google' | 'duckDuckGo' | 'bing' | 'brave'
export type BrowserNewTabBehavior = 'startPage' | 'homepage'

export const browserClientSettings = defineSettings({
  scope: 'client',
  keys: {
    /** The client's own upstream proxy (may hold credentials); empty is direct. */
    browserProxyUrl: setting(''),
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
