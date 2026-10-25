import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { browserInvoke, browserWebContentsId, createBrowser, observe, act, activeAction, fixtureEvaluate, inspectFixture, target } from './fixtures/browser-control'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { closeApp, launchApp, makeProject, openWorkspace } from './fixtures/electron-app'

let app: ElectronApplication
let page: Page
let home: string

test.beforeEach(async () => {
  ;({ electronApp: app, mainWindow: page, home } = await launchApp())
})

test.afterEach(async () => {
  await closeApp(app)
})

test('target-bound browser input preserves renderer and workspace focus', async () => {
  test.setTimeout(60_000)
  const url = `data:text/html,${encodeURIComponent(
    '<title>Background Automation</title><label for="name">Name</label><input id="name" aria-label="Name"><button id="ready">Ready</button>',
  )}`
  const browser = await createBrowser(page, url, { x: 120, y: 120 })

  await expect.poll(
    () => browserWebContentsId(page, browser.panelId),
    { timeout: 20_000 },
  ).not.toBeNull()
  const initialSnapshot = await browserInvoke(page, browser, 'getAXState', { disableDiffing: true })
  if (!initialSnapshot.ok) throw new Error(`initial browser snapshot failed: ${initialSnapshot.error}`)
  expect(initialSnapshot).toMatchObject({
    ok: true,
    result: { state: expect.stringContaining('button "Ready"') },
  })

  // Browser-only CI deliberately does not package the terminal runtime. A real
  // host control still proves target-bound guest input leaves renderer focus alone.
  const rendererFocusTarget = page.getByRole('button', { name: /Select tool/ })
  await rendererFocusTarget.focus()
  await expect(rendererFocusTarget).toBeFocused()

  const firstFill = await act(page, browser, 'setValue', "Name", { value: 'Renderer focus preserved' })
  if (!firstFill.ok) throw new Error(`browser fill failed: ${firstFill.error}`)
  await expect(rendererFocusTarget).toBeFocused()

  // A click and a key press never keep the guest focused, so a user typing
  // elsewhere keeps typing there.
  await expect(act(page, browser, 'click', 'Name')).resolves.toMatchObject({ ok: true })
  await expect(rendererFocusTarget).toBeFocused()
  await expect(activeAction(page, browser, 'pressKey', { key: '!' })).resolves.toMatchObject({ ok: true })
  await expect(rendererFocusTarget).toBeFocused()
  await expect(activeAction(page, browser, 'pressKey', { key: '?' })).resolves.toMatchObject({ ok: true })
  await expect(rendererFocusTarget).toBeFocused()
  await expect(inspectFixture(app!, page, browser, "document.querySelector(\"#name\")?.value")).resolves.toMatchObject({ ok: true, result: { value: expect.stringContaining('!?') } })

  const otherWorkspace = await openWorkspace(page, makeProject(home, { name: 'other' }))
  await expect(act(page, browser, 'setValue', "Name", { value: 'Filled from another workspace' })).resolves.toMatchObject({ ok: true })
  // Browser control is target-bound: it must not switch back to the browser's
  // workspace or invent a canvas in this intentionally empty destination.
  expect(await page.evaluate(() => window.__cateE2E!.selectedWorkspaceId())).toBe(otherWorkspace)
  expect(await page.evaluate(() => window.__cateE2E!.activeCanvasPanelId())).toBeNull()

  await expect(inspectFixture(app!, page, browser, "document.querySelector(\"#name\")?.value")).resolves.toMatchObject({ ok: true, result: { value: 'Filled from another workspace' } })
})

test('agents typing in two browsers at once reach their own pages and leave focus alone', async () => {
  test.setTimeout(60_000)
  const html = (title: string) => `data:text/html,${encodeURIComponent(`<title>${title}</title><input id="name" aria-label="Name">`)}`
  const left = await createBrowser(page, html('Left'), { x: 60, y: 60 })
  const right = await createBrowser(page, html('Right'), { x: 900, y: 60 })
  for (const browser of [left, right]) {
    await expect.poll(() => browserWebContentsId(page, browser.panelId), { timeout: 20_000 }).not.toBeNull()
    await expect(act(page, browser, 'click', 'Name')).resolves.toMatchObject({ ok: true })
  }
  const rendererFocusTarget = page.getByRole('button', { name: /Select tool/ })
  await rendererFocusTarget.focus()

  // Each click moves the window's focused guest; keys must not follow it.
  const type = async (browser: typeof left, keys: string) => {
    for (const key of keys) {
      await expect(browserInvoke(page, browser, 'pressKey', { key })).resolves.toMatchObject({ ok: true })
      await expect(act(page, browser, 'click', 'Name')).resolves.toMatchObject({ ok: true })
    }
  }
  await Promise.all([type(left, 'abcde'), type(right, 'VWXYZ')])
  await expect(rendererFocusTarget).toBeFocused()
  const value = (browser: typeof left) => inspectFixture(app!, page, browser, 'document.querySelector("#name").value.split("").sort().join("")')
  await expect(value(left)).resolves.toMatchObject({ ok: true, result: { value: 'abcde' } })
  await expect(value(right)).resolves.toMatchObject({ ok: true, result: { value: 'VWXYZ' } })
})

test('the browser guest survives switching to another workspace and back', async () => {
  const browser = await createBrowser(page, `data:text/html,${encodeURIComponent('<title>Survivor</title>')}`, { x: 120, y: 120 })
  await fixtureEvaluate(app, page, browser, `window.__survival = 'same guest'`)
  const guest = await browserWebContentsId(page, browser.panelId)
  const first = await page.evaluate(() => window.__cateE2E!.selectedWorkspaceId())
  await openWorkspace(page, makeProject(home, { name: 'other' }))
  await page.evaluate((id) => window.__cateE2E!.selectWorkspace(id!), first)
  expect(await browserWebContentsId(page, browser.panelId)).toBe(guest)
  expect(await fixtureEvaluate(app, page, browser, 'window.__survival')).toBe('same guest')
})

test('browser is always a normal canvas card across zoom and pan', async () => {
  const browser = await createBrowser(page, 'data:text/html,<title>Stable canvas card</title><h1>Browser page</h1>', { x: 120, y: 120 })
  const nodeId = await expect.poll(() => page.evaluate(
    (panelId) => window.__cateE2E!.nodeForPanel(panelId), browser.panelId,
  )).not.toBeNull().then(() => page.evaluate((panelId) => window.__cateE2E!.nodeForPanel(panelId), browser.panelId))
  const node = page.locator(`[data-node-id="${nodeId}"]`)
  const surface = page.locator(`[data-browser-surface="${browser.panelId}"]`)
  await expect(node.locator(`[data-browser-surface-slot="${browser.panelId}"]`)).toBeVisible()
  await expect(surface).toHaveAttribute('data-browser-surface-visible', 'true')
  await expect(surface.locator('webview')).toHaveCount(1)
  const guestId = await expect.poll(
    () => browserWebContentsId(page, browser.panelId),
    { timeout: 20_000 },
  ).not.toBeNull().then(() => browserWebContentsId(page, browser.panelId))

  await page.evaluate(() => {
    window.__cateE2E!.setZoom(0.45)
    window.__cateE2E!.setViewport({ x: 260, y: 140 })
  })
  await expect(surface).toHaveAttribute('data-browser-surface-visible', 'true')
  expect(await browserWebContentsId(page, browser.panelId)).toBe(guestId)
})

test('user clicks and types directly in the live webview at non-default zoom', async () => {
  const url = `data:text/html,${encodeURIComponent(`
    <title>Interactive preview</title>
    <style>html,body{margin:0}#name{position:absolute;left:16px;top:16px;width:240px;height:40px}#save{position:absolute;left:16px;top:80px;width:160px;height:40px}</style>
    <input id="name" aria-label="Name"><button id="save" onclick="document.body.dataset.saved=document.querySelector('#name').value">Save</button>
  `)}`
  const browser = await createBrowser(page, url, { x: 120, y: 120 })
  const webview = page.locator(`[data-browser-surface="${browser.panelId}"] webview`).first()
  await expect(webview).toBeVisible({ timeout: 20_000 })
  const guestId = await expect.poll(
    () => browserWebContentsId(page, browser.panelId),
    { timeout: 20_000 },
  ).not.toBeNull().then(() => browserWebContentsId(page, browser.panelId))
  await page.evaluate(() => window.__cateE2E!.setZoom(0.65))

  const guestClick = (x: number, y: number) => app.evaluate(({ webContents }, input) => {
    const guest = webContents.fromId(input.id!)!
    guest.focus()
    guest.sendInputEvent({ type: 'mouseDown', x: input.x, y: input.y, button: 'left', clickCount: 1 })
    guest.sendInputEvent({ type: 'mouseUp', x: input.x, y: input.y, button: 'left', clickCount: 1 })
  }, { id: guestId, x, y })

  await guestClick(120, 36)
  await expect.poll(() => inspectFixture(app!, page, browser, 'document.activeElement?.id ?? ""'), { timeout: 20_000 }).toMatchObject({ ok: true, result: { value: 'name' } })
  await app.evaluate(({ webContents }, input) => {
    const guest = webContents.fromId(input.id!)!
    for (const char of input.text) {
      guest.sendInputEvent({ type: 'keyDown', keyCode: char })
      guest.sendInputEvent({ type: 'char', keyCode: char })
      guest.sendInputEvent({ type: 'keyUp', keyCode: char })
    }
  }, { id: guestId, text: 'Typed inside Cate' })
  await expect.poll(() => inspectFixture(app!, page, browser, "document.querySelector(\"#name\")?.value"), { timeout: 20_000 }).toMatchObject({ ok: true, result: { value: 'Typed inside Cate' } })

  await guestClick(80, 100)
  await expect.poll(() => inspectFixture(app!, page, browser, "document.querySelector(\"body\")?.getAttribute(\"data-saved\")"), { timeout: 20_000 }).toMatchObject({ ok: true, result: { value: 'Typed inside Cate' } })
})

test('snapshots omit hidden and boxless links while keeping off-screen links clickable', async () => {
  const url = `data:text/html,${encodeURIComponent(`
    <title>Snapshot visibility</title>
    <a href="#" onclick="event.preventDefault();document.body.dataset.clicked='yes'">Visible link</a>
    <a href="#" hidden>Hidden attribute</a>
    <div style="display:none"><a href="#">Hidden ancestor</a></div>
    <a href="#" style="visibility:hidden">Hidden visibility</a>
    <a href="#" style="opacity:0">Transparent link</a>
    <a href="#" style="display:contents">Boxless link</a>
    <a href="#" style="display:block;width:0;height:0;overflow:hidden">Zero size link</a>
    <a href="#" style="position:absolute;top:3000px" onclick="event.preventDefault();document.body.dataset.clicked='offscreen'">Offscreen link</a>
  `)}`
  const browser = await createBrowser(page, url, { x: 120, y: 120 })
  await expect.poll(
    () => browserWebContentsId(page, browser.panelId),
    { timeout: 20_000 },
  ).not.toBeNull()
  for (const visual of [false, true]) {
    const observation = await observe(page, browser, visual)
    const refs = observation.elements
    const links = refs.filter((ref) => ref.role === 'link')
    expect(links.map((ref) => ref.name)).toEqual(['Visible link', 'Offscreen link'])
    for (const [index, link] of links.entries()) {
      expect(await activeAction(page, browser, 'click', { target: link.id })).toMatchObject({ ok: true })
      expect(await inspectFixture(app!, page, browser, "document.querySelector(\"body\")?.getAttribute(\"data-clicked\")")).toMatchObject({ ok: true, result: { value: index === 0 ? 'yes' : 'offscreen' } })
    }
  }
})

/** A page whose button keeps the click that pressed it waiting ~2.5 s (its
 *  request), so a test can type while an agent's action is in flight. */
async function slowPage(): Promise<{ url: string; close(): void }> {
  const server = http.createServer((req, res) => {
    if (req.url === '/slow') { setTimeout(() => res.end('ok'), 2500); return }
    res.setHeader('content-type', 'text/html')
    res.end('<title>Slow</title><input id="name" aria-label="Name"><button onclick="fetch(\'/slow\')">Slow</button>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, close: () => server.close() }
}

/** A host input the person types into, focused. */
async function hostInput(page: Page): Promise<void> {
  await page.evaluate(() => {
    const input = document.createElement('input')
    input.id = 'e2e-host-input'
    Object.assign(input.style, { position: 'fixed', left: '10px', bottom: '10px', zIndex: '99999' })
    document.body.appendChild(input)
    input.focus()
  })
}

for (const where of ['this workspace', 'another workspace'] as const) {
  test(`a person typing in ${where} while an agent clicks keeps their keys, and the agent keeps going`, async () => {
    test.setTimeout(60_000)
    const slow = await slowPage()
    try {
      const browser = await createBrowser(page, slow.url, { x: 120, y: 120 })
      const button = await target(page, browser, 'Slow')
      if (where === 'another workspace') await openWorkspace(page, makeProject(home, { name: 'other' }))
      await hostInput(page)
      const click = browserInvoke(page, browser, 'click', button)
      await page.waitForTimeout(500)
      await expect(page.locator('#e2e-host-input')).toBeFocused()
      await page.keyboard.type('mine')
      await expect(click).resolves.toMatchObject({ ok: true })
      await expect(page.locator('#e2e-host-input')).toHaveValue('mine')
      await expect(page.locator('#e2e-host-input')).toBeFocused()
      await expect(inspectFixture(app, page, browser, 'document.querySelector("#name").value')).resolves.toMatchObject({ result: { value: '' } })
    } finally {
      slow.close()
    }
  })
}

test('an agent screenshots a browser parked in another workspace, unseen', async () => {
  test.setTimeout(60_000)
  const browser = await createBrowser(page, `data:text/html,${encodeURIComponent('<title>Parked</title><body style="background:#c00"><h1>Parked page</h1>')}`, { x: 120, y: 120 })
  await openWorkspace(page, makeProject(home, { name: 'other' }))
  const surface = page.locator(`[data-browser-surface="${browser.panelId}"]`)
  await expect(surface).toHaveAttribute('data-browser-surface-visible', 'false')
  const observation = await observe(page, browser, true)
  expect(observation.screenshotError).toBeUndefined()
  expect(observation.screenshot).toMatchObject({ width: expect.any(Number), height: expect.any(Number) })
  // Released again: parked and hidden.
  await expect(surface).toHaveCSS('visibility', 'hidden')
})

test('agents pick native select options by label, value or option id, never through the OS menu', async () => {
  const url = `data:text/html,${encodeURIComponent(`<title>Select</title><label>Country <select id="country" onchange="document.body.dataset.changed=this.value">
    <option value="">Pick one</option><optgroup label="Europe"><option value="de">Germany</option></optgroup><option value="us">United States</option>
  </select></label>`)}`
  const browser = await createBrowser(page, url, { x: 120, y: 120 })
  const value = () => fixtureEvaluate(app, page, browser, 'document.querySelector("#country").value + "|" + (document.body.dataset.changed ?? "")')
  const observation = await observe(page, browser)
  expect(observation.state).toContain('option "United States" value="us"')
  const country = await target(page, browser, 'Country', 'combobox')
  await expect(browserInvoke(page, browser, 'selectOption', { ...country, values: 'Germany' })).resolves.toMatchObject({ ok: true })
  expect(await value()).toBe('de|de')
  await expect(browserInvoke(page, browser, 'selectOption', { ...(await target(page, browser, 'Country', 'combobox')), values: 'us' })).resolves.toMatchObject({ ok: true })
  expect(await value()).toBe('us|us')
  await expect(act(page, browser, 'click', 'Pick one', {}, 'option')).resolves.toMatchObject({ ok: true })
  expect(await value()).toBe('|')
  await expect(act(page, browser, 'click', 'Country', {}, 'combobox')).resolves.toMatchObject({ ok: false, error: expect.stringContaining('browser-native-select') })
})
