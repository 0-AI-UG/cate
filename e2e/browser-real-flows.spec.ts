import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
      html(response, '<title>Cross-origin frame</title><button id="cross-frame" onclick="this.dataset.clicked=\'yes\'">Cross-frame action</button>')
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
      html(response, '<title>Same-origin frame</title><button id="same-frame" onclick="this.dataset.clicked=\'yes\'">Same-frame action</button>')
      return
    }
    if (url.pathname === '/components') {
      html(response, `<title>Component lab</title><main><h1>Component lab</h1><div id="open-host"></div><div id="closed-host"></div><iframe title="Same origin" src="/frame"></iframe><iframe title="Cross origin" src="${docsOrigin}/frame"></iframe></main><script>
        const openRoot = document.querySelector('#open-host').attachShadow({ mode: 'open' });
        openRoot.innerHTML = '<button id="open-shadow">Open-shadow action</button>';
        openRoot.querySelector('button').addEventListener('click', function () { this.dataset.clicked = 'yes' });
        const closedRoot = document.querySelector('#closed-host').attachShadow({ mode: 'closed' });
        closedRoot.innerHTML = '<button id="closed-shadow">Closed-shadow action</button>';
        closedRoot.querySelector('button').addEventListener('click', function () { this.dataset.clicked = 'yes' });
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

async function invoke(
  browser: { workspaceId: string; panelId: string },
  method: string,
  args: Record<string, unknown> = {},
) {
  return page.evaluate(({ browser, method, args }) => window.__cateE2E!.browserInvoke(
    browser.workspaceId, method, { panelId: browser.panelId, ...args },
  ), { browser, method, args })
}

test('completes authenticated shopping and cross-origin documentation flows', async () => {
  test.setTimeout(90_000)
  const browser = await page.evaluate((url) => window.__cateE2E!.createBrowser(url, { x: 100, y: 100 }), `${shopOrigin}/login`)

  await expect.poll(() => invoke(browser, 'readCommand', { command: ['snapshot', '-i'] }), { timeout: 20_000 })
    .toMatchObject({ ok: true, result: { snapshot: expect.stringContaining('Sign in') } })
  await expect(invoke(browser, 'command', { command: ['fill', '#email', 'agent@example.test'] })).resolves.toMatchObject({ ok: true })
  await expect(invoke(browser, 'command', { command: ['fill', '#password', 'correct horse battery staple'] })).resolves.toMatchObject({ ok: true })
  await expect(invoke(browser, 'command', { command: ['click', '#signin'] })).resolves.toMatchObject({ ok: true })

  await expect.poll(() => invoke(browser, 'current'), { timeout: 20_000 })
    .toMatchObject({ ok: true, result: { url: `${shopOrigin}/dashboard` } })
  await expect(invoke(browser, 'readCommand', { command: ['get', 'text', 'h1'] })).resolves
    .toMatchObject({ ok: true, result: { text: 'Welcome, automation user' } })

  await expect(invoke(browser, 'command', { command: ['click', '#add'] })).resolves.toMatchObject({ ok: true })
  await expect(invoke(browser, 'readCommand', { command: ['get', 'text', '#cart-count'] })).resolves
    .toMatchObject({ ok: true, result: { text: '1' } })

  const initialTabs = await invoke(browser, 'tabs') as { ok: boolean; result: { tabs: Array<{ id: string }> } }
  const shopTabId = initialTabs.result.tabs[0].id
  const docsTab = await invoke(browser, 'tabNew', { url: docsOrigin }) as { ok: boolean; result: { tabId: string } }
  expect(docsTab.ok).toBe(true)
  await expect.poll(() => invoke(browser, 'current'), { timeout: 20_000 })
    .toMatchObject({ ok: true, result: { url: `${docsOrigin}/` } })
  await expect(invoke(browser, 'command', { command: ['fill', '#docs-query', 'background input'] })).resolves.toMatchObject({ ok: true })
  await expect(invoke(browser, 'command', { command: ['press', 'Enter'] })).resolves.toMatchObject({ ok: true })
  await expect.poll(() => invoke(browser, 'readCommand', { command: ['get', 'text', '#result'] }), { timeout: 20_000 })
    .toMatchObject({ ok: true, result: { text: 'Result for background input' } })

  await expect.poll(() => invoke(browser, 'tabSelect', { tabId: shopTabId }), { timeout: 20_000 })
    .toMatchObject({ ok: true })
  await expect.poll(() => invoke(browser, 'current'), { timeout: 20_000 })
    .toMatchObject({ ok: true, result: { url: `${shopOrigin}/dashboard` } })

  await expect(invoke(browser, 'command', { command: ['click', '#support'] })).resolves.toMatchObject({ ok: true })
  await expect.poll(() => invoke(browser, 'current'), { timeout: 20_000 })
    .toMatchObject({ ok: true, result: { url: `${shopOrigin}/support` } })
  await expect(invoke(browser, 'command', { command: ['fill', '#question', 'Where is my order?'] })).resolves.toMatchObject({ ok: true })
  await expect(invoke(browser, 'command', { command: ['click', '#ask'] })).resolves.toMatchObject({ ok: true })
  await expect.poll(() => invoke(browser, 'readCommand', { command: ['get', 'text', '#support-answer'] }), { timeout: 20_000 })
    .toMatchObject({ ok: true, result: { text: 'Received: Where is my order?' } })
  const popupTabs = await invoke(browser, 'tabs') as { ok: boolean; result: { tabs: Array<{ id: string; active: boolean }> } }
  expect(popupTabs.result.tabs).toHaveLength(3)
  const popupTabId = popupTabs.result.tabs.find((tab) => tab.active)!.id
  await expect(invoke(browser, 'tabClose', { tabId: popupTabId })).resolves.toMatchObject({ ok: true })
  await expect(invoke(browser, 'tabSelect', { tabId: shopTabId })).resolves.toMatchObject({ ok: true })

  await expect(invoke(browser, 'command', { command: ['click', '#checkout'] })).resolves.toMatchObject({ ok: true })
  await expect.poll(() => invoke(browser, 'current'), { timeout: 20_000 })
    .toMatchObject({ ok: true, result: { url: `${shopOrigin}/checkout` } })
  await expect(invoke(browser, 'command', { command: ['fill', '#address', 'Invalidenstrasse 117, Berlin'] })).resolves.toMatchObject({ ok: true })
  await expect(invoke(browser, 'command', { command: ['select', '#country', 'DE'] })).resolves.toMatchObject({ ok: true })
  await expect(invoke(browser, 'command', { command: ['check', '#terms'] })).resolves.toMatchObject({ ok: true })
  await expect(invoke(browser, 'command', { command: ['click', '#place-order'] })).resolves.toMatchObject({ ok: true })
  await expect.poll(() => invoke(browser, 'readCommand', { command: ['get', 'text', '#order-id'] }), { timeout: 20_000 })
    .toMatchObject({ ok: true, result: { text: 'Order CATE-4242' } })

  await expect(invoke(browser, 'back')).resolves.toMatchObject({ ok: true })
  await expect.poll(() => invoke(browser, 'current'), { timeout: 20_000 })
    .toMatchObject({ ok: true, result: { url: `${shopOrigin}/checkout` } })
  await expect(invoke(browser, 'forward')).resolves.toMatchObject({ ok: true })
  await expect.poll(() => invoke(browser, 'current'), { timeout: 20_000 })
    .toMatchObject({ ok: true, result: { url: `${shopOrigin}/confirmation` } })
  await expect(invoke(browser, 'back')).resolves.toMatchObject({ ok: true })

  await expect(invoke(browser, 'open', { url: `${shopOrigin}/dashboard` })).resolves.toMatchObject({ ok: true })
  await expect(invoke(browser, 'command', { command: ['click', '#download'] })).resolves.toMatchObject({ ok: true })
  await expect.poll(async () => {
    const result = await invoke(browser, 'downloads') as {
      ok: boolean
      result: { downloads: Array<{ url: string; filePath: string; state: string }> }
    }
    return result.result.downloads.find((download) => download.url === `${shopOrigin}/receipt.csv`)?.state
  }, { timeout: 20_000 }).toBe('completed')
  const downloads = await invoke(browser, 'downloads') as {
    ok: boolean
    result: { downloads: Array<{ url: string; filePath: string; state: string }> }
  }
  const receipt = downloads.result.downloads.find((download) => download.url === `${shopOrigin}/receipt.csv`)
  expect(receipt?.filePath).toContain('receipt.csv')
  expect(existsSync(receipt!.filePath)).toBe(true)
  expect(readFileSync(receipt!.filePath, 'utf8')).toBe('item,quantity\nkeyboard,1\n')

  await expect(invoke(browser, 'viewport', { preset: 'mobile', width: 390, height: 844 })).resolves
    .toMatchObject({ ok: true, result: { preset: 'mobile', width: 390, height: 844 } })
  await expect.poll(() => invoke(browser, 'evaluate', { expression: 'innerWidth' }), { timeout: 20_000 })
    .toMatchObject({ ok: true, result: { value: 390 } })
  await expect(invoke(browser, 'resize', { width: 700, height: 520 })).resolves
    .toMatchObject({ ok: true, result: { width: 700, height: 520 } })
  await expect.poll(() => page.evaluate((panelId) => (
    window.__cateE2E!.nodes().find((node) => node.panelId === panelId)?.size
  ), browser.panelId)).toEqual({ width: 700, height: 520 })

  await expect(invoke(browser, 'viewport', { preset: 'compact', width: 640, height: 480 })).resolves
    .toMatchObject({ ok: true, result: { preset: 'compact', width: 640, height: 480 } })
  await expect.poll(() => page.evaluate((panelId) => {
    const webview = document.querySelector(`[data-browser-surface="${panelId}"] webview`) as HTMLElement | null
    return webview?.style.width ?? ''
  }, browser.panelId), { timeout: 20_000 }).toContain('%')
  const screenshot = await invoke(browser, 'readCommand', { command: ['screenshot', '--full'] }) as {
    ok: boolean
    result: { path: string }
  }
  expect(screenshot.ok).toBe(true)
  expect(existsSync(screenshot.result.path)).toBe(true)
  expect(statSync(screenshot.result.path).size).toBeGreaterThan(100)
})

test('recovers from SPA rerenders and serializes concurrent actions', async () => {
  const browser = await page.evaluate((url) => window.__cateE2E!.createBrowser(url, { x: 100, y: 100 }), `${shopOrigin}/spa`)

  await expect.poll(() => invoke(browser, 'readCommand', {
    command: ['wait', '--text', 'Issue title', '--timeout', '5000'],
  }), { timeout: 20_000 }).toMatchObject({ ok: true })
  await expect(invoke(browser, 'command', {
    command: ['find', 'label', 'Issue title', 'fill', 'Browser regression'],
  })).resolves.toMatchObject({ ok: true })
  await expect(invoke(browser, 'command', {
    command: ['find', 'role', 'button', 'click', '--name', 'Create issue'],
  })).resolves.toMatchObject({ ok: true })
  await expect.poll(() => invoke(browser, 'readCommand', {
    command: ['get', 'text', '#issue-name'],
  }), { timeout: 20_000 }).toMatchObject({ ok: true, result: { text: 'Browser regression' } })

  const observation = await invoke(browser, 'readCommand', { command: ['snapshot', '-i'] }) as {
    ok: boolean
    result: { refs: Array<{ ref: string; name: string }> }
  }
  const editRef = observation.result.refs.find((ref) => ref.name === 'Edit issue')?.ref
  expect(editRef).toBeTruthy()
  await expect(invoke(browser, 'command', { command: ['click', editRef!] })).resolves.toMatchObject({ ok: true })

  const detachedRef = await invoke(browser, 'command', { command: ['click', editRef!] })
  expect(detachedRef.ok).toBe(false)
  expect(detachedRef.error).toBeTruthy()

  await expect.poll(async () => {
    const result = await invoke(browser, 'readCommand', { command: ['snapshot', '-i'] }) as {
      ok: boolean
      result?: { refs: Array<{ ref: string; name: string; role: string }> }
    }
    return result.result?.refs.some((ref) => ref.role === 'textbox' || ref.role === 'searchbox') ?? false
  }, { timeout: 20_000 }).toBe(true)
  const refreshed = await invoke(browser, 'readCommand', { command: ['snapshot', '-i'] }) as {
    ok: boolean
    result: { refs: Array<{ ref: string; name: string; role: string }> }
  }
  const titleRef = refreshed.result.refs.find((ref) => ref.role === 'textbox' || ref.role === 'searchbox')?.ref
  expect(titleRef).toBeTruthy()
  await expect(invoke(browser, 'command', { command: ['fill', titleRef!, 'Recovered issue'] })).resolves.toMatchObject({ ok: true })
  await expect(invoke(browser, 'command', {
    command: ['find', 'role', 'button', 'click', '--name', 'Save issue'],
  })).resolves.toMatchObject({ ok: true })
  await expect(invoke(browser, 'readCommand', { command: ['get', 'text', '#issue-name'] })).resolves
    .toMatchObject({ ok: true, result: { text: 'Recovered issue' } })

  const concurrent = await Promise.all([
    invoke(browser, 'command', { command: ['click', '#counter'] }),
    invoke(browser, 'command', { command: ['click', '#counter'] }),
  ])
  expect(concurrent).toEqual([expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true })])
  await expect(invoke(browser, 'readCommand', { command: ['get', 'text', '#count'] })).resolves
    .toMatchObject({ ok: true, result: { text: '2' } })
})

test('acts through accessibility refs inside open and closed shadow roots', async () => {
  const browser = await page.evaluate((url) => window.__cateE2E!.createBrowser(url, { x: 100, y: 100 }), `${shopOrigin}/components`)
  const observation = await expect.poll(async () => {
    const result = await invoke(browser, 'readCommand', { command: ['snapshot', '-i'] }) as {
      ok: boolean
      result?: { refs: Array<{ ref: string; name: string }> }
    }
    return result.ok ? result.result : undefined
  }, { timeout: 20_000 }).toEqual(expect.objectContaining({
    refs: expect.arrayContaining([
      expect.objectContaining({ name: 'Open-shadow action' }),
      expect.objectContaining({ name: 'Closed-shadow action' }),
    ]),
  })).then(() => invoke(browser, 'readCommand', { command: ['snapshot', '-i'] }) as Promise<{
    ok: boolean
    result: { refs: Array<{ ref: string; name: string }> }
  }>)

  for (const name of ['Open-shadow action', 'Closed-shadow action']) {
    const ref = observation.result.refs.find((candidate) => candidate.name === name)?.ref
    expect(ref, name).toBeTruthy()
    await expect(invoke(browser, 'command', { command: ['click', ref!] })).resolves.toMatchObject({ ok: true })
    await expect(invoke(browser, 'readCommand', { command: ['get', 'attr', ref!, 'data-clicked'] })).resolves
      .toMatchObject({ ok: true, result: { value: 'yes' } })
  }
})

test('keeps concurrent workflows isolated across multiple live browser panels', async () => {
  const [first, second] = await page.evaluate((origin) => [
    window.__cateE2E!.createBrowser(`${origin}/spa`, { x: 80, y: 80 }),
    window.__cateE2E!.createBrowser(`${origin}/spa`, { x: 760, y: 80 }),
  ], shopOrigin)
  for (const browser of [first, second]) {
    await expect.poll(() => invoke(browser, 'readCommand', {
      command: ['wait', '#issue-title', '--state', 'visible', '--timeout', '5000'],
    }), { timeout: 20_000 }).toMatchObject({ ok: true })
  }

  await Promise.all([
    invoke(first, 'command', { command: ['fill', '#issue-title', 'First panel'] }),
    invoke(second, 'command', { command: ['fill', '#issue-title', 'Second panel'] }),
  ])
  await expect(invoke(first, 'readCommand', { command: ['get', 'value', '#issue-title'] })).resolves
    .toMatchObject({ ok: true, result: { value: 'First panel' } })
  await expect(invoke(second, 'readCommand', { command: ['get', 'value', '#issue-title'] })).resolves
    .toMatchObject({ ok: true, result: { value: 'Second panel' } })

  await Promise.all([
    invoke(first, 'command', { command: ['click', '#counter'] }),
    invoke(first, 'command', { command: ['click', '#counter'] }),
    invoke(second, 'command', { command: ['click', '#counter'] }),
  ])
  await expect(invoke(first, 'readCommand', { command: ['get', 'text', '#count'] })).resolves
    .toMatchObject({ ok: true, result: { text: '2' } })
  await expect(invoke(second, 'readCommand', { command: ['get', 'text', '#count'] })).resolves
    .toMatchObject({ ok: true, result: { text: '1' } })
})

test('observes 10,000 interactive controls within the workflow latency budget', async ({ browserName: _browserName }, testInfo) => {
  const browser = await page.evaluate((url) => window.__cateE2E!.createBrowser(url, { x: 100, y: 100 }), `${shopOrigin}/large-dom`)
  await expect.poll(() => invoke(browser, 'current'), { timeout: 20_000 })
    .toMatchObject({ ok: true, result: { url: `${shopOrigin}/large-dom`, loading: false } })

  const startedAt = performance.now()
  const observation = await invoke(browser, 'readCommand', { command: ['snapshot', '-i'] }) as {
    ok: boolean
    result: { refs: Array<{ ref: string; name: string }> }
  }
  const elapsedMs = performance.now() - startedAt
  expect(observation.ok).toBe(true)
  expect(observation.result.refs).toHaveLength(10_000)
  expect(observation.result.refs.at(-1)?.name).toBe('Control 10000')
  expect(elapsedMs).toBeLessThan(10_000)
  await testInfo.attach('browser-observation-metrics.json', {
    body: JSON.stringify({ controls: observation.result.refs.length, elapsedMs }, null, 2),
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
    const result = await invoke(browser, 'readCommand', { command: ['snapshot', '-i'] }) as {
      ok: boolean
      result?: { refs: Array<{ ref: string; name: string }> }
    }
    return result.ok && result.result?.refs.some((ref) => ref.name === 'Same-frame action')
      && result.result.refs.some((ref) => ref.name === 'Cross-frame action')
      ? result.result
      : undefined
  }, { timeout: 20_000 }).toBeTruthy().then(() => invoke(browser, 'readCommand', { command: ['snapshot', '-i'] }) as Promise<{
    ok: boolean
    result: { refs: Array<{ ref: string; name: string }> }
  }>).then((result) => result.result)
  for (const name of ['Same-frame action', 'Cross-frame action']) {
    const ref = observation.refs.find((candidate) => candidate.name === name)?.ref
    expect(ref, name).toBeTruthy()
    await expect(invoke(browser, 'command', { command: ['click', ref!] })).resolves.toMatchObject({ ok: true })
    await expect(invoke(browser, 'readCommand', { command: ['get', 'attr', ref!, 'data-clicked'] })).resolves
      .toMatchObject({ ok: true, result: { value: 'yes' } })
  }
})

test('does not silently lose a click after a responsive viewport round trip', async () => {
  const browser = await page.evaluate((url) => window.__cateE2E!.createBrowser(url, { x: 100, y: 100 }), `${shopOrigin}/login`)
  await expect.poll(() => invoke(browser, 'readCommand', {
    command: ['wait', '#signin', '--state', 'visible', '--timeout', '5000'],
  }), { timeout: 20_000 }).toMatchObject({ ok: true })
  await invoke(browser, 'command', { command: ['fill', '#email', 'viewport@example.test'] })
  await invoke(browser, 'command', { command: ['fill', '#password', 'viewport test'] })
  await invoke(browser, 'command', { command: ['click', '#signin'] })
  await expect.poll(() => invoke(browser, 'current'), { timeout: 20_000 })
    .toMatchObject({ ok: true, result: { url: `${shopOrigin}/dashboard` } })
  await invoke(browser, 'viewport', { preset: 'mobile', width: 390, height: 844 })
  await invoke(browser, 'viewport', { preset: 'compact', width: 640, height: 480 })
  await expect(invoke(browser, 'command', { command: ['click', '#download'] })).resolves.toMatchObject({ ok: true })
  await expect.poll(() => invoke(browser, 'downloads'), { timeout: 20_000 }).toMatchObject({
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
    await expect.poll(() => invoke(browser, 'readCommand', {
      command: ['wait', '#attachment', '--state', 'visible'],
    }), { timeout: 20_000 }).toMatchObject({ ok: true })
    await expect(invoke(browser, 'command', {
      command: ['upload', '#attachment', uploadPath],
    })).resolves.toMatchObject({ ok: true })
    await expect(invoke(browser, 'readCommand', {
      command: ['get', 'text', '#selected'],
    })).resolves.toMatchObject({ ok: true, result: { text: 'browser-upload-fixture.txt' } })
  } finally {
    rmSync(uploadDir, { recursive: true, force: true })
  }
})
