// Shared workspace, browser panel: tabs, URLs, zoom and viewport are session
// state both clients share. Which tab a client shows is its own; the
// session's active tab (what `cate.browser.*` acts on) follows the last
// selection. Each client loads the page in its own webview,
// and a page on the runtime machine's loopback reaches B through loopback
// routing. Page actions from the cate API run on the driving client.

import { test, expect } from '@playwright/test'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { call, callError, describeShared, doc, sessionOp, sessionOpError, seedShared, snapshot, type SharedClient } from '../fixtures/shared-workspace'
import { guestEvaluate, guestUrls } from '../fixtures/electron-app'

type Tab = { id: string; url: string; title: string; pinned: boolean }
type BrowserSnapshot = { tabs: Tab[]; activeTabId: string; zoom: number; viewport: { preset: string; width?: number; height?: number }; canGoBack: boolean }
const br = (c: SharedClient, id: string) => snapshot<BrowserSnapshot>(c, id)
const activeTab = async (c: SharedClient, id: string) => {
  const s = await br(c, id)
  return s?.tabs.find((t) => t.id === s.activeTabId)
}

let server: http.Server
let base = ''

test.beforeAll(async () => {
  // Bound to loopback on the runtime's machine only.
  server = http.createServer((req, res) => {
    const name = (req.url ?? '/').replace(/^\//, '') || 'home'
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html><head><title>Page ${name}</title></head><body><h1>${name}</h1><button id="go">Go</button></body></html>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
test.afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })

describeShared('browser', (pair) => {
  let panelId: string

  test('a browser made in A loads the page in both clients', async () => {
    const { a, b } = pair()
    ;({ panelId } = await seedShared(pair(), a, 'browser', { x: 80, y: 80 }, { url: `${base}/one` }))
    for (const c of [a, b]) {
      await expect.poll(async () => (await activeTab(c, panelId))?.title, { timeout: 30_000 }).toBe('Page one')
      await expect.poll(() => guestUrls(c.app.electronApp), { timeout: 30_000 }).toContainEqual(expect.stringContaining('/one'))
    }
    await expect.poll(() => guestEvaluate(b.app.electronApp, `${base}/one`, 'document.querySelector("h1").textContent').catch(() => null), { timeout: 20_000 })
      .toBe('one')
  })

  test('navigate from B moves both clients and the record', async () => {
    const { a, b } = pair()
    await sessionOp(b, panelId, { kind: 'navigate', input: `${base}/two` })
    for (const c of [a, b]) {
      await expect.poll(async () => (await activeTab(c, panelId))?.url, { timeout: 20_000 }).toBe(`${base}/two`)
      await expect.poll(() => guestUrls(c.app.electronApp), { timeout: 20_000 }).toContainEqual(expect.stringContaining('/two'))
      await expect.poll(async () => (await doc(c))?.panels[panelId]?.fields.url).toBe(`${base}/two`)
      await expect.poll(async () => (await doc(c))?.panels[panelId]?.title, { timeout: 20_000 }).toBe('Page two')
    }
    expect(await sessionOpError(a, panelId, { kind: 'navigate', input: '' })).toBe('rejected')
  })

  test('back from A returns both clients to the previous page', async () => {
    const { a, b } = pair()
    // Clients following a navigation report their history state too.
    for (const c of [a, b]) await expect.poll(async () => (await br(c, panelId))?.canGoBack, { timeout: 20_000 }).toBe(true)
    expect(await sessionOp(a, panelId, { kind: 'history', action: 'back' })).toBe(true)
    for (const c of [a, b]) await expect.poll(async () => (await activeTab(c, panelId))?.url, { timeout: 20_000 }).toBe(`${base}/one`)
  })

  test('tabs opened, pinned, selected and closed in one client show in the other', async () => {
    const { a, b } = pair()
    const tabId = await sessionOp<string>(a, panelId, { kind: 'newTab', url: `${base}/three` })
    await expect.poll(async () => (await br(b, panelId))?.tabs.map((t) => t.id)).toContain(tabId)
    await expect.poll(async () => (await br(b, panelId))?.activeTabId).toBe(tabId)
    await expect.poll(async () => (await activeTab(b, panelId))?.title, { timeout: 20_000 }).toBe('Page three')

    await sessionOp(b, panelId, { kind: 'pin', tabId, pinned: true })
    await expect.poll(async () => (await br(a, panelId))?.tabs.find((t) => t.id === tabId)?.pinned).toBe(true)

    const first = (await br(a, panelId))!.tabs.find((t) => t.id !== tabId)!.id
    // B's selection becomes the session's active tab, the cate API's target.
    await sessionOp(b, panelId, { kind: 'selectTab', tabId: first })
    await expect.poll(async () => (await br(a, panelId))?.activeTabId).toBe(first)

    await sessionOp(a, panelId, { kind: 'closeTab', tabId })
    await expect.poll(async () => (await br(b, panelId))?.tabs.map((t) => t.id)).toEqual([first])
    expect(await sessionOpError(b, panelId, { kind: 'selectTab', tabId })).toBe('gone')
  })

  test('zoom and viewport are shared, invalid values are refused', async () => {
    const { a, b } = pair()
    await sessionOp(a, panelId, { kind: 'setZoom', zoom: 1.5 })
    await expect.poll(async () => (await br(b, panelId))?.zoom).toBe(1.5)
    await sessionOp(b, panelId, { kind: 'stepZoom', direction: -1 })
    await expect.poll(async () => (await br(a, panelId))?.zoom).toBeLessThan(1.5)
    expect(await sessionOpError(a, panelId, { kind: 'setZoom', zoom: 9 })).toBe('rejected')

    await sessionOp(b, panelId, { kind: 'setViewport', viewport: { preset: 'mobile', width: 390, height: 844 } })
    await expect.poll(async () => (await br(a, panelId))?.viewport).toMatchObject({ preset: 'mobile' })
    await sessionOp(a, panelId, { kind: 'setViewport', viewport: { preset: 'compact' } })
    await sessionOp(a, panelId, { kind: 'setZoom', zoom: 1 })
  })

  test('the cate API reads the page from either client', async () => {
    const { a, b } = pair()
    for (const c of [b, a]) {
      const tab = await call<{ tabId: string; url: string }>(c, 'api', 'call', { method: 'cate.browser.getTab', args: { panelId } })
      expect(tab.url).toBe(`${base}/one`)
      const ax = await call<{ text?: string }>(c, 'api', 'call', { method: 'cate.browser.getAXState', args: { panelId, tabId: tab.tabId, disableDiffing: true } })
      expect(JSON.stringify(ax)).toContain('Go')
    }
    const tabs = await call<unknown[]>(b, 'api', 'call', { method: 'cate.browser.listTabs', args: { panelId } })
    expect(JSON.stringify(tabs)).toContain(`${base}/one`)
  })

  test('a page action through the cate API shows in the other client', async () => {
    const { a, b } = pair()
    const tab = await call<{ tabId: string }>(b, 'api', 'call', { method: 'cate.browser.getTab', args: { panelId } })
    await call(b, 'api', 'call', { method: 'cate.browser.goto', args: { panelId, tabId: tab.tabId, url: `${base}/four` } })
    await expect.poll(async () => (await activeTab(a, panelId))?.url, { timeout: 20_000 }).toBe(`${base}/four`)
    expect(await callError(a, 'api', 'call', { method: 'cate.browser.goto', args: { panelId, tabId: 'tab-missing', url: `${base}/x` } })).not.toBe('ok')
  })

  test('bookmarks and history are workspace data both clients read', async () => {
    const { a, b } = pair()
    await call(a, 'browserData', 'addBookmark', { url: `${base}/one`, title: 'Shared bookmark' })
    await expect.poll(async () => JSON.stringify(await call(b, 'browserData', 'bookmarks'))).toContain('Shared bookmark')
    await call(b, 'browserData', 'removeBookmark', { url: `${base}/one` })
    await expect.poll(async () => JSON.stringify(await call(a, 'browserData', 'bookmarks'))).not.toContain('Shared bookmark')

    // Visits the panel made are recorded once, for everyone.
    await expect.poll(async () => JSON.stringify(await call(b, 'browserData', 'queryHistory', { query: 'Page', limit: 50 })), { timeout: 20_000 })
      .toContain(`${base}/two`)
    await call(a, 'browserData', 'clearHistory')
    await expect.poll(async () => JSON.stringify(await call(b, 'browserData', 'queryHistory', { query: 'Page', limit: 50 }))).not.toContain(`${base}/two`)
  })
})
