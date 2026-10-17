import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createHistoryStore, type HistoryStore } from './historyStore'

let dir: string
let store: HistoryStore
let clock = 1

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-browser-'))
  store = createHistoryStore(path.join(dir, 'browser'), { now: () => clock++ })
})
afterEach(() => {
  store.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('history', () => {
  test('records a visit and dedups by url, bumping visitCount + title', () => {
    store.recordVisit('https://a.com', 'A')
    store.recordVisit('https://a.com', 'A v2')
    const h = store.history()
    expect(h).toHaveLength(1)
    expect(h[0].visitCount).toBe(2)
    expect(h[0].title).toBe('A v2')
  })

  test('orders by most-recent visit', () => {
    store.recordVisit('https://a.com', 'A')
    store.recordVisit('https://b.com', 'B')
    store.recordVisit('https://a.com', 'A')
    expect(store.history()[0].url).toBe('https://a.com')
  })

  test('query matches url or title, case-insensitive, respects limit', () => {
    store.recordVisit('https://github.com', 'GitHub')
    store.recordVisit('https://gitlab.com', 'GitLab')
    store.recordVisit('https://example.com', 'Example')
    expect(store.queryHistory('git', 10).map((e) => e.url).sort()).toEqual(['https://github.com', 'https://gitlab.com'])
    expect(store.queryHistory('git', 1)).toHaveLength(1)
  })

  test('ignores the new-tab sentinel and blank urls', () => {
    store.recordVisit('cate://newtab', 'New Tab')
    store.recordVisit('about:blank', '')
    store.recordVisit('', '')
    expect(store.history()).toHaveLength(0)
  })

  test('persists to <data>/browser/history.json and reloads', async () => {
    store.recordVisit('https://a.com', 'A')
    await store.flush()
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'browser', 'history.json'), 'utf8'))
    expect(onDisk.entries[0].url).toBe('https://a.com')
    store.dispose()
    store = createHistoryStore(path.join(dir, 'browser'))
    expect(store.history().map((e) => e.url)).toEqual(['https://a.com'])
  })
})

describe('bookmarks', () => {
  test('add is idempotent by url and removable', async () => {
    store.addBookmark('https://a.com', 'A')
    store.addBookmark('https://a.com', 'A again')
    expect(store.bookmarks()).toHaveLength(1)
    await store.flush()
    expect(fs.existsSync(path.join(dir, 'browser', 'bookmarks.json'))).toBe(true)
    store.removeBookmark('https://a.com')
    expect(store.bookmarks()).toHaveLength(0)
  })

  test('subscribers see local changes', () => {
    const kinds: string[] = []
    const off = store.subscribe((change) => kinds.push(change.kind))
    store.addBookmark('https://a.com', 'A')
    store.recordVisit('https://a.com', 'A')
    off()
    expect(kinds).toEqual(['bookmarks', 'history'])
  })
})
