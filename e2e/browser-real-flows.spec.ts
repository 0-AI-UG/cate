import { browserInvoke, popupBinding, target, act, activeAction, waitForText, inspectFixture } from './fixtures/browser-control'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { closeApp, launchApp } from './fixtures/electron-app'

let app: ElectronApplication
let page: Page
let shopServer: Server
let docsServer: Server
let shopOrigin: string
let docsOrigin: string

function html(response: ServerResponse, body: string, status = 200): void {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  response.end(`<!doctype html><html><head><meta charset="utf-8">${body}</head></html>`)
}

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

test.beforeAll(async () => {
  docsServer = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://docs.test')
    if (url.pathname === '/frame') {
      html(response, '<title>Cross-origin frame</title><button id="cross-frame" onclick="this.dataset.clicked=\'yes\';this.textContent+=\' complete\'">Cross-frame action</button>')
      return
    }
    if (url.pathname === '/results') {
      html(response, `<title>Docs results</title><main><h1>Documentation results</h1><p id="result">Result for ${url.searchParams.get('q') ?? ''}</p></main>`)
      return
    }
    html(response, `<title>Product docs</title><main><h1>Product documentation</h1><form action="/results"><label>Search docs <input id="docs-query" name="q"></label><button>Search</button></form></main>`)
  })
  docsOrigin = await listen(docsServer)

  shopServer = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://shop.test')
    if (request.method === 'POST' && url.pathname === '/session') {
      response.writeHead(303, { location: '/dashboard', 'set-cookie': 'cate-session=authenticated; Path=/; HttpOnly' })
      response.end()
      return
    }
    if (url.pathname === '/dashboard' && !request.headers.cookie?.includes('cate-session=authenticated')) {
      response.writeHead(302, { location: '/login' })
      response.end()
      return
    }
    if (url.pathname === '/login' || url.pathname === '/') {
      html(response, `<title>Cate Shop sign in</title><main><h1>Sign in</h1><form method="post" action="/session"><label>Email <input id="email" name="email" type="email"></label><label>Password <input id="password" name="password" type="password"></label><button id="signin">Sign in</button></form></main>`)
      return
    }
    if (url.pathname === '/dashboard') {
      html(response, `<title>Cate Shop</title><main><h1>Welcome, automation user</h1><p>Cart: <strong id="cart-count">0</strong></p><button id="add" onclick="document.querySelector('#cart-count').textContent=String(Number(document.querySelector('#cart-count').textContent)+1)">Add keyboard to cart</button><button id="support" onclick="window.open('/support', 'support')">Open support</button><a id="checkout" href="/checkout">Checkout</a><a id="download" href="/receipt.csv" download>Download receipt</a><a id="docs" href="${docsOrigin}">Product docs</a></main>`)
      return
    }
    if (url.pathname === '/support') {
      const question = url.searchParams.get('question')
      html(response, question
        ? `<title>Support response</title><main><h1>Support response</h1><p id="support-answer">Received: ${question}</p></main>`
        : '<title>Support</title><main><h1>Support</h1><form><label>Question <input id="question" name="question"></label><button id="ask">Ask</button></form></main>')
      return
    }
    if (url.pathname === '/checkout' && request.method === 'GET') {
      html(response, `<title>Checkout</title><main><h1>Checkout</h1><form method="post" action="/checkout"><label>Shipping address <input id="address" name="address"></label><label>Country <select id="country" name="country"><option value="">Choose</option><option value="DE">Germany</option><option value="US">United States</option></select></label><label><input id="terms" type="checkbox" name="terms"> Accept terms</label><button id="place-order">Place order</button></form></main>`)
      return
    }
    if (url.pathname === '/checkout' && request.method === 'POST') {
      response.writeHead(303, { location: '/confirmation' })
      response.end()
      return
    }
    if (url.pathname === '/confirmation') {
      html(response, '<title>Order confirmed</title><main><h1>Order confirmed</h1><p id="order-id">Order CATE-4242</p></main>')
      return
    }
    if (url.pathname === '/spa') {
      html(response, `<title>Issue tracker</title><main><h1>Issue tracker</h1><div id="app">Hydrating application</div><button id="counter">Increment</button><output id="count">0</output></main><script>
        const root = document.querySelector('#app');
        const renderEditor = (value = '') => {
          root.innerHTML = '<label>Issue title <input id="issue-title" value="' + value + '"></label><button id="save-issue">' + (value ? 'Save issue' : 'Create issue') + '</button>';
          root.querySelector('#save-issue').addEventListener('click', () => renderIssue(root.querySelector('#issue-title').value));
        };
        const renderIssue = (value) => {
          root.innerHTML = '<article><h2 id="issue-name">' + value + '</h2><button id="edit-issue">Edit issue</button></article>';
          root.querySelector('#edit-issue').addEventListener('click', () => renderEditor(value));
        };
        document.querySelector('#counter').addEventListener('click', () => {
          const count = document.querySelector('#count'); count.value = String(Number(count.value) + 1); count.textContent = count.value;
        });
        setTimeout(() => renderEditor(), 150);
      </script>`)
      return
    }
    if (url.pathname === '/frame') {
      html(response, '<title>Same-origin frame</title><button id="same-frame" onclick="this.dataset.clicked=\'yes\';this.textContent+=\' complete\'">Same-frame action</button>')
      return
    }
    if (url.pathname === '/components') {
      html(response, `<title>Component lab</title><main><h1>Component lab</h1><div id="open-host"></div><div id="closed-host"></div><iframe title="Same origin" src="/frame"></iframe><iframe title="Cross origin" src="${docsOrigin}/frame"></iframe></main><script>
        const openRoot = document.querySelector('#open-host').attachShadow({ mode: 'open' });
        openRoot.innerHTML = '<button id="open-shadow">Open-shadow action</button>';
        openRoot.querySelector('button').addEventListener('click', function () { this.dataset.clicked = 'yes'; this.textContent += ' complete' });
        const closedRoot = document.querySelector('#closed-host').attachShadow({ mode: 'closed' });
        closedRoot.innerHTML = '<button id="closed-shadow">Closed-shadow action</button>';
        closedRoot.querySelector('button').addEventListener('click', function () { this.dataset.clicked = 'yes'; this.textContent += ' complete' });
      </script>`)
      return
    }
    if (url.pathname === '/large-dom') {
      const controls = Array.from({ length: 10_000 }, (_, index) => `<button>Control ${index + 1}</button>`).join('')
      html(response, `<title>Large DOM</title><main><h1>Large DOM</h1>${controls}</main>`)
      return
    }
    if (url.pathname === '/upload') {
      html(response, `<title>Upload fixture</title><main><h1>Upload a document</h1><label>Attachment <input id="attachment" type="file"></label><output id="selected">Nothing selected</output></main><script>
        document.querySelector('#attachment').addEventListener('change', (event) => {
          document.querySelector('#selected').textContent = event.target.files[0]?.name ?? 'Nothing selected';
        });
      </script>`)
      return
    }
    if (url.pathname === '/receipt.csv') {
      response.writeHead(200, {
        'content-type': 'text/csv',
        'content-disposition': 'attachment; filename="receipt.csv"',
      })
      response.end('item,quantity\nkeyboard,1\n')
      return
    }
    response.writeHead(404).end('not found')
  })
  shopOrigin = await listen(shopServer)
})

test.afterAll(async () => {
  await Promise.all([
    new Promise<void>((resolve) => shopServer.close(() => resolve())),
    new Promise<void>((resolve) => docsServer.close(() => resolve())),
  ])
})

test.beforeEach(async () => {
  ;({ electronApp: app, mainWindow: page } = await launchApp())
})

test.afterEach(async () => {
  await closeApp(app)
})


test('completes authenticated shopping and cross-origin documentation flows', async () => {
  test.setTimeout(90_000)
  const browser = await page.evaluate((url) => window.__cateE2E!.createBrowser(url, { x: 100, y: 100 }), `${shopOrigin}/login`)

  await expect.poll(() => browserInvoke(page, browser, 'getAXState', { disableDiffing: true }), { timeout: 20_000 })
    .toMatchObject({ ok: true, result: { state: expect.stringContaining('Sign in') } })
  await expect(act(page, browser, 'setValue', "Email", { value: 'agent@example.test' })).resolves.toMatchObject({ ok: true })
  await expect(act(page, browser, 'setValue', "Password", { value: 'correct horse battery staple' })).resolves.toMatchObject({ ok: true })
  await expect(act(page, browser, 'click', "Sign in", {}, 'button')).resolves.toMatchObject({ ok: true })

  await expect.poll(() => browserInvoke(page, browser, 'getTab'), { timeout: 20_000 })
    .toMatchObject({ ok: true, result: { url: `${shopOrigin}/dashboard` } })
  await expect(inspectFixture(app!, page, browser, "document.querySelector(\"h1\")?.textContent ?? ''", 'text')).resolves
    .toMatchObject({ ok: true, result: { text: 'Welcome, automation user' } })

  await expect(act(page, browser, 'click', "Add keyboard to cart")).resolves.toMatchObject({ ok: true })
  await expect(inspectFixture(app!, page, browser, "document.querySelector(\"#cart-count\")?.textContent ?? ''", 'text')).resolves
    .toMatchObject({ ok: true, result: { text: '1' } })

  const initialTabs = await browserInvoke(page, browser, 'listTabs') as { ok: boolean; result: { tabs: Array<{ id: string }> } }
  const shopTabId = initialTabs.result.tabs[0].id
  const docsTab = await browserInvoke(page, browser, 'createTab', { url: docsOrigin }) as { ok: boolean; result: { tabId: string } }
  expect(docsTab.ok).toBe(true)
  const docs = { ...browser, tabId: docsTab.result.tabId }
  await expect.poll(() => browserInvoke(page, docs, 'getTab'), { timeout: 20_000 })
    .toMatchObject({ ok: true, result: { url: `${docsOrigin}/` } })
  await expect(act(page, docs, 'setValue', "Search docs", { value: 'background input' })).resolves.toMatchObject({ ok: true })
  await expect(activeAction(page, docs, 'pressKey', { key: 'Enter' })).resolves.toMatchObject({ ok: true })
  await expect.poll(() => inspectFixture(app!, page, docs, "document.querySelector(\"#result\")?.textContent ?? ''", 'text'), { timeout: 20_000 })
    .toMatchObject({ ok: true, result: { text: 'Result for background input' } })

  await expect.poll(() => browserInvoke(page, browser, 'getTab', { tabId: shopTabId }), { timeout: 20_000 })
    .toMatchObject({ ok: true })
  await expect.poll(() => browserInvoke(page, browser, 'getTab'), { timeout: 20_000 })
    .toMatchObject({ ok: true, result: { url: `${shopOrigin}/dashboard` } })

  await expect(act(page, browser, 'click', "Open support")).resolves.toMatchObject({ ok: true })
  const popup = await popupBinding(page, browser, `${shopOrigin}/support`)
  await expect.poll(() => browserInvoke(page, popup, 'getTab'), { timeout: 20_000 })
    .toMatchObject({ ok: true, result: { url: `${shopOrigin}/support` } })
  await expect(act(page, popup, 'setValue', "Question", { value: 'Where is my order?' })).resolves.toMatchObject({ ok: true })
  await expect(act(page, popup, 'click', "Ask")).resolves.toMatchObject({ ok: true })
  await expect.poll(() => inspectFixture(app!, page, popup, "document.querySelector(\"#support-answer\")?.textContent ?? ''", 'text'), { timeout: 20_000 })
    .toMatchObject({ ok: true, result: { text: 'Received: Where is my order?' } })
  const popupTabs = await browserInvoke(page, browser, 'listTabs') as { ok: boolean; result: { tabs: Array<{ id: string; active: boolean }> } }
  expect(popupTabs.result.tabs).toHaveLength(3)
  const popupTabId = popup.tabId
  await expect(browserInvoke(page, browser, 'close', { tabId: popupTabId })).resolves.toMatchObject({ ok: true })
  await expect(browserInvoke(page, browser, 'getTab', { tabId: shopTabId })).resolves.toMatchObject({ ok: true })

  await expect(act(page, browser, 'click', "Checkout")).resolves.toMatchObject({ ok: true })
  await expect.poll(() => browserInvoke(page, browser, 'getTab'), { timeout: 20_000 })
    .toMatchObject({ ok: true, result: { url: `${shopOrigin}/checkout` } })
  await expect(act(page, browser, 'setValue', "Shipping address", { value: 'Invalidenstrasse 117, Berlin' })).resolves.toMatchObject({ ok: true })
  await expect(act(page, browser, 'selectOption', "Country", { values: ['DE'] })).resolves.toMatchObject({ ok: true })
  await expect(act(page, browser, 'setChecked', "Accept terms", { checked: true })).resolves.toMatchObject({ ok: true })
  await expect(act(page, browser, 'click', "Place order")).resolves.toMatchObject({ ok: true })
  await expect.poll(() => inspectFixture(app!, page, browser, "document.querySelector(\"#order-id\")?.textContent ?? ''", 'text'), { timeout: 20_000 })
    .toMatchObject({ ok: true, result: { text: 'Order CATE-4242' } })

  await expect(browserInvoke(page, browser, 'back')).resolves.toMatchObject({ ok: true })
  await expect.poll(() => browserInvoke(page, browser, 'getTab'), { timeout: 20_000 })
    .toMatchObject({ ok: true, result: { url: `${shopOrigin}/checkout` } })
  await expect(browserInvoke(page, browser, 'forward')).resolves.toMatchObject({ ok: true })
  await expect.poll(() => browserInvoke(page, browser, 'getTab'), { timeout: 20_000 })
    .toMatchObject({ ok: true, result: { url: `${shopOrigin}/confirmation` } })
  await expect(browserInvoke(page, browser, 'back')).resolves.toMatchObject({ ok: true })

  await expect(browserInvoke(page, browser, 'goto', { url: `${shopOrigin}/dashboard` })).resolves.toMatchObject({ ok: true })
  await expect(act(page, browser, 'click', "Download receipt")).resolves.toMatchObject({ ok: true })
  await expect.poll(async () => {
    const result = await browserInvoke(page, browser, 'downloads') as {
      ok: boolean
      result: { downloads: Array<{ url: string; filePath: string; state: string }> }
    }
    return result.result.downloads.find((download) => download.url === `${shopOrigin}/receipt.csv`)?.state
  }, { timeout: 20_000 }).toBe('completed')
  const downloads = await browserInvoke(page, browser, 'downloads') as {
    ok: boolean
    result: { downloads: Array<{ url: string; filePath: string; state: string }> }
  }
  const receipt = downloads.result.downloads.find((download) => download.url === `${shopOrigin}/receipt.csv`)
  expect(receipt?.filePath).toContain('receipt.csv')
  expect(existsSync(receipt!.filePath)).toBe(true)
  expect(readFileSync(receipt!.filePath, 'utf8')).toBe('item,quantity\nkeyboard,1\n')

  await expect(browserInvoke(page, browser, 'setViewport', { preset: 'mobile', width: 390, height: 844 })).resolves
    .toMatchObject({ ok: true, result: { preset: 'mobile', width: 390, height: 844 } })
  await expect.poll(() => inspectFixture(app!, page, browser, 'innerWidth'), { timeout: 20_000 })
    .toMatchObject({ ok: true, result: { value: 390 } })
  await expect(browserInvoke(page, browser, 'resize', { width: 700, height: 520 })).resolves
    .toMatchObject({ ok: true, result: { width: 700, height: 520 } })
  await expect.poll(() => page.evaluate((panelId) => (
    window.__cateE2E!.nodes().find((node) => node.panelId === panelId)?.size
  ), browser.panelId)).toEqual({ width: 700, height: 520 })

  await expect(browserInvoke(page, browser, 'setViewport', { preset: 'compact', width: 640, height: 480 })).resolves
    .toMatchObject({ ok: true, result: { preset: 'compact', width: 640, height: 480 } })
  await expect.poll(() => page.evaluate((panelId) => {
    const webview = document.querySelector(`[data-browser-surface="${panelId}"] webview`) as HTMLElement | null
    return webview?.style.width ?? ''
  }, browser.panelId), { timeout: 20_000 }).toContain('%')
  const screenshot = await browserInvoke(page, browser, 'getScreenshot') as {
    ok: boolean
    result: { screenshot: { data: string; mimeType: string } }
  }
  expect(screenshot.ok).toBe(true)
  expect(screenshot.result.screenshot.mimeType).toBe('image/png')
  expect(Buffer.from(screenshot.result.screenshot.data, 'base64').length).toBeGreaterThan(100)
})

test('recovers from SPA rerenders and serializes concurrent actions', async () => {
  const browser = await page.evaluate((url) => window.__cateE2E!.createBrowser(url, { x: 100, y: 100 }), `${shopOrigin}/spa`)

  await expect.poll(() => waitForText(page, browser, 'Issue title'), { timeout: 20_000 }).toMatchObject({ ok: true })
  await expect(act(page, browser, 'setValue', 'Issue title', { value: 'Browser regression' })).resolves.toMatchObject({ ok: true })
  await expect(act(page, browser, 'click', 'Create issue', {}, 'button')).resolves.toMatchObject({ ok: true })
  await expect.poll(() => inspectFixture(app!, page, browser, "document.querySelector(\"#issue-name\")?.textContent ?? ''", 'text'), { timeout: 20_000 }).toMatchObject({ ok: true, result: { text: 'Browser regression' } })

  const observation = await browserInvoke(page, browser, 'getAXState', { disableDiffing: true }) as {
    ok: boolean
    result: { elements: Array<{ id: number; name: string; role: string }> }
  }
  const editRef = observation.result.elements.find((ref) => ref.name === 'Edit issue')?.id
  expect(editRef).toBeTruthy()
  await expect(activeAction(page, browser, 'click', { target: editRef! })).resolves.toMatchObject({ ok: true })

  const detachedRef = await activeAction(page, browser, 'click', { target: editRef! })
  expect(detachedRef.ok).toBe(false)
  expect(detachedRef.error).toBeTruthy()

  await expect.poll(async () => {
    const result = await browserInvoke(page, browser, 'getAXState', { disableDiffing: true }) as {
      ok: boolean
      result?: { elements: Array<{ id: number; name: string; role: string }> }
    }
    return result.result?.elements.some((ref) => ref.role === 'textbox' || ref.role === 'searchbox') ?? false
  }, { timeout: 20_000 }).toBe(true)
  const refreshed = await browserInvoke(page, browser, 'getAXState', { disableDiffing: true }) as {
    ok: boolean
    result: { elements: Array<{ id: number; name: string; role: string }> }
  }
  const titleRef = refreshed.result.elements.find((ref) => ref.role === 'textbox' || ref.role === 'searchbox')?.id
  expect(titleRef).toBeTruthy()
  await expect(activeAction(page, browser, 'setValue', { target: titleRef!, value: 'Recovered issue' })).resolves.toMatchObject({ ok: true })
  await expect(act(page, browser, 'click', 'Save issue', {}, 'button')).resolves.toMatchObject({ ok: true })
  await expect(inspectFixture(app!, page, browser, "document.querySelector(\"#issue-name\")?.textContent ?? ''", 'text')).resolves
    .toMatchObject({ ok: true, result: { text: 'Recovered issue' } })

  const concurrent = await Promise.all([
    act(page, browser, 'click', "Increment"),
    act(page, browser, 'click', "Increment"),
  ])
  expect(concurrent).toEqual([expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true })])
  await expect(inspectFixture(app!, page, browser, "document.querySelector(\"#count\")?.textContent ?? ''", 'text')).resolves
    .toMatchObject({ ok: true, result: { text: '2' } })
})

test('acts through accessibility refs inside open and closed shadow roots', async () => {
  const browser = await page.evaluate((url) => window.__cateE2E!.createBrowser(url, { x: 100, y: 100 }), `${shopOrigin}/components`)
  const observation = await expect.poll(async () => {
    const result = await browserInvoke(page, browser, 'getAXState', { disableDiffing: true }) as {
      ok: boolean
      result?: { elements: Array<{ id: number; name: string; role: string }> }
    }
    return result.ok ? result.result : undefined
  }, { timeout: 20_000 }).toEqual(expect.objectContaining({
    elements: expect.arrayContaining([
      expect.objectContaining({ name: 'Open-shadow action' }),
      expect.objectContaining({ name: 'Closed-shadow action' }),
    ]),
  })).then(() => browserInvoke(page, browser, 'getAXState', { disableDiffing: true }) as Promise<{
    ok: boolean
    result: { elements: Array<{ id: number; name: string; role: string }> }
  }>)

  for (const name of ['Open-shadow action', 'Closed-shadow action']) {
    const ref = observation.result.elements.find((candidate) => candidate.name === name)?.id
    expect(ref, name).toBeTruthy()
    await expect(activeAction(page, browser, 'click', { target: ref! })).resolves.toMatchObject({ ok: true })
    await expect(target(page, browser, `${name} complete`, 'button').then(() => ({ ok: true }))).resolves.toMatchObject({ ok: true })
  }
})

test('keeps concurrent workflows isolated across multiple live browser panels', async () => {
  const [first, second] = await page.evaluate((origin) => [
    window.__cateE2E!.createBrowser(`${origin}/spa`, { x: 80, y: 80 }),
    window.__cateE2E!.createBrowser(`${origin}/spa`, { x: 760, y: 80 }),
  ], shopOrigin)
  for (const browser of [first, second]) {
    await expect.poll(() => target(page, browser, "Issue title").then(() => ({ ok: true })), { timeout: 20_000 }).toMatchObject({ ok: true })
  }

  await Promise.all([
    act(page, first, 'setValue', "Issue title", { value: 'First panel' }),
    act(page, second, 'setValue', "Issue title", { value: 'Second panel' }),
  ])
  await expect(inspectFixture(app!, page, first, "document.querySelector(\"#issue-title\")?.value")).resolves
    .toMatchObject({ ok: true, result: { value: 'First panel' } })
  await expect(inspectFixture(app!, page, second, "document.querySelector(\"#issue-title\")?.value")).resolves
    .toMatchObject({ ok: true, result: { value: 'Second panel' } })

  await Promise.all([
    act(page, first, 'click', "Increment"),
    act(page, first, 'click', "Increment"),
    act(page, second, 'click', "Increment"),
  ])
  await expect(inspectFixture(app!, page, first, "document.querySelector(\"#count\")?.textContent ?? ''", 'text')).resolves
    .toMatchObject({ ok: true, result: { text: '2' } })
  await expect(inspectFixture(app!, page, second, "document.querySelector(\"#count\")?.textContent ?? ''", 'text')).resolves
    .toMatchObject({ ok: true, result: { text: '1' } })
})

test('observes 10,000 interactive controls within the workflow latency budget', async ({ browserName: _browserName }, testInfo) => {
  const browser = await page.evaluate((url) => window.__cateE2E!.createBrowser(url, { x: 100, y: 100 }), `${shopOrigin}/large-dom`)
  await expect.poll(() => browserInvoke(page, browser, 'getTab'), { timeout: 20_000 })
    .toMatchObject({ ok: true, result: { url: `${shopOrigin}/large-dom` } })

  const startedAt = performance.now()
  const observation = await browserInvoke(page, browser, 'getAXState', { disableDiffing: true }) as {
    ok: boolean
    result: { elements: Array<{ id: number; name: string; role: string }> }
  }
  const elapsedMs = performance.now() - startedAt
  expect(observation.ok).toBe(true)
  expect(observation.result.elements.filter((element) => element.role === 'button' && element.name.startsWith('Control '))).toHaveLength(10_000)
  expect(observation.result.elements.at(-1)?.name).toBe('Control 10000')
  expect(elapsedMs).toBeLessThan(10_000)
  await testInfo.attach('browser-observation-metrics.json', {
    body: JSON.stringify({ controls: observation.result.elements.length, elapsedMs }, null, 2),
    contentType: 'application/json',
  })
})

test('renders the password manager across the complete browser content area', async () => {
  const browser = await page.evaluate(() => window.__cateE2E!.createBrowser(
    'chrome://password-manager/passwords', { x: 100, y: 100 },
  ))
  const manager = page.locator(`[data-browser-surface="${browser.panelId}"] [data-browser-password-manager]`)
  await expect(manager).toBeVisible()
  await expect(manager.getByRole('heading', { name: 'Password manager' })).toBeVisible()
  await manager.getByRole('button', { name: 'Advanced' }).click()
  await expect(manager.getByRole('heading', { name: 'Import passwords' })).toBeVisible()

  const dimensions = await manager.evaluate((element) => {
    const own = element.getBoundingClientRect()
    const parent = element.parentElement!.getBoundingClientRect()
    return { width: own.width, height: own.height, parentWidth: parent.width, parentHeight: parent.height }
  })
  expect(Math.abs(dimensions.width - dimensions.parentWidth)).toBeLessThan(1)
  expect(Math.abs(dimensions.height - dimensions.parentHeight)).toBeLessThan(1)
})

test('acts through accessibility refs inside same-origin and cross-origin frames', async () => {
  const browser = await page.evaluate((url) => window.__cateE2E!.createBrowser(url, { x: 100, y: 100 }), `${shopOrigin}/components`)
  const observation = await expect.poll(async () => {
    const result = await browserInvoke(page, browser, 'getAXState', { disableDiffing: true }) as {
      ok: boolean
      result?: { elements: Array<{ id: number; name: string; role: string }> }
    }
    return result.ok && result.result?.elements.some((ref) => ref.name === 'Same-frame action')
      && result.result.elements.some((ref) => ref.name === 'Cross-frame action')
      ? result.result
      : undefined
  }, { timeout: 20_000 }).toBeTruthy().then(() => browserInvoke(page, browser, 'getAXState', { disableDiffing: true }) as Promise<{
    ok: boolean
    result: { elements: Array<{ id: number; name: string; role: string }> }
  }>).then((result) => result.result)
  for (const name of ['Same-frame action', 'Cross-frame action']) {
    const ref = observation.elements.find((candidate) => candidate.name === name)?.id
    expect(ref, name).toBeTruthy()
    await expect(activeAction(page, browser, 'click', { target: ref! })).resolves.toMatchObject({ ok: true })
    await expect(target(page, browser, `${name} complete`, 'button').then(() => ({ ok: true }))).resolves.toMatchObject({ ok: true })
  }
})

test('does not silently lose a click after a responsive viewport round trip', async () => {
  const browser = await page.evaluate((url) => window.__cateE2E!.createBrowser(url, { x: 100, y: 100 }), `${shopOrigin}/login`)
  await expect.poll(() => target(page, browser, "Sign in").then(() => ({ ok: true })), { timeout: 20_000 }).toMatchObject({ ok: true })
  await act(page, browser, 'setValue', "Email", { value: 'viewport@example.test' })
  await act(page, browser, 'setValue', "Password", { value: 'viewport test' })
  await act(page, browser, 'click', "Sign in", {}, 'button')
  await expect.poll(() => browserInvoke(page, browser, 'getTab'), { timeout: 20_000 })
    .toMatchObject({ ok: true, result: { url: `${shopOrigin}/dashboard` } })
  await browserInvoke(page, browser, 'setViewport', { preset: 'mobile', width: 390, height: 844 })
  await browserInvoke(page, browser, 'setViewport', { preset: 'compact', width: 640, height: 480 })
  await expect(act(page, browser, 'click', "Download receipt")).resolves.toMatchObject({ ok: true })
  await expect.poll(() => browserInvoke(page, browser, 'downloads'), { timeout: 20_000 }).toMatchObject({
    ok: true,
    result: { downloads: [expect.objectContaining({ url: `${shopOrigin}/receipt.csv`, state: 'completed' })] },
  })
})

test('uploads a user-granted local file into a page file input', async () => {
  const uploadDir = mkdtempSync(path.join(tmpdir(), 'cate-browser-upload-'))
  const uploadPath = path.join(uploadDir, 'browser-upload-fixture.txt')
  writeFileSync(uploadPath, 'uploaded through Cate\n')
  try {
    const browser = await page.evaluate((url) => window.__cateE2E!.createBrowser(url, { x: 100, y: 100 }), `${shopOrigin}/upload`)
    await expect.poll(() => target(page, browser, "Attachment").then(() => ({ ok: true })), { timeout: 20_000 }).toMatchObject({ ok: true })
    await expect(act(page, browser, 'upload', "Attachment", { filePath: uploadPath })).resolves.toMatchObject({ ok: true })
    await expect(inspectFixture(app!, page, browser, "document.querySelector(\"#selected\")?.textContent ?? ''", 'text')).resolves.toMatchObject({ ok: true, result: { text: 'browser-upload-fixture.txt' } })
  } finally {
    rmSync(uploadDir, { recursive: true, force: true })
  }
})
