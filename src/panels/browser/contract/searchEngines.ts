import type { BrowserSearchEngine } from '@services/browser/contract/settings'

export type { BrowserSearchEngine }

export const SEARCH_ENGINE_URLS: Record<BrowserSearchEngine, string> = {
  google: 'https://www.google.com/search?q=',
  duckDuckGo: 'https://duckduckgo.com/?q=',
  bing: 'https://www.bing.com/search?q=',
  brave: 'https://search.brave.com/search?q=',
}
