// =============================================================================
// browserStateStore — global browser history + bookmarks under <userData>/.
// =============================================================================
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-browser-test-'))
vi.mock('electron', () => {
  const electron = { app: { getPath: () => userData } }
  return { ...electron, default: electron }
})
vi.mock('./logger', () => ({
  default: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
}))

const store = await import('./browserStateStore')

beforeEach(() => {
  store.clearBrowserHistory()
  for (const b of store.getBookmarks()) store.removeBookmark(b.url)
})
afterAll(() => { try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* noop */ } })

describe('history', () => {
  test('records a visit and dedups by url, bumping visitCount + title', () => {
    store.recordBrowserVisit('https://a.com', 'A')
    store.recordBrowserVisit('https://a.com', 'A v2')
    const h = store.getBrowserHistory()
    expect(h).toHaveLength(1)
    expect(h[0].visitCount).toBe(2)
    expect(h[0].title).toBe('A v2')
  })

  test('orders by most-recent visit', () => {
    store.recordBrowserVisit('https://a.com', 'A')
    store.recordBrowserVisit('https://b.com', 'B')
    store.recordBrowserVisit('https://a.com', 'A')
    expect(store.getBrowserHistory()[0].url).toBe('https://a.com')
  })

  test('query matches url or title, case-insensitive, respects limit', () => {
    store.recordBrowserVisit('https://github.com', 'GitHub')
    store.recordBrowserVisit('https://gitlab.com', 'GitLab')
    store.recordBrowserVisit('https://example.com', 'Example')
    const r = store.queryBrowserHistory('git', 10)
    expect(r.map((e) => e.url).sort()).toEqual(['https://github.com', 'https://gitlab.com'])
    expect(store.queryBrowserHistory('git', 1)).toHaveLength(1)
  })

  test('ignores the new-tab sentinel and blank urls', () => {
    store.recordBrowserVisit('cate://newtab', 'New Tab')
    store.recordBrowserVisit('about:blank', '')
    store.recordBrowserVisit('', '')
    expect(store.getBrowserHistory()).toHaveLength(0)
  })
})

describe('bookmarks', () => {
  test('add is idempotent by url and removable', () => {
    store.addBookmark('https://a.com', 'A')
    store.addBookmark('https://a.com', 'A again')
    expect(store.getBookmarks()).toHaveLength(1)
    store.removeBookmark('https://a.com')
    expect(store.getBookmarks()).toHaveLength(0)
  })
})
