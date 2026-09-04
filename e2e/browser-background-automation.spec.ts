import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { closeApp, launchApp } from './fixtures/electron-app'

let app: ElectronApplication
let page: Page

test.beforeEach(async () => {
  ;({ electronApp: app, mainWindow: page } = await launchApp())
})

test.afterEach(async () => {
  await closeApp(app)
})

test('target-bound browser input preserves renderer and workspace focus', async () => {
  test.setTimeout(60_000)
  const url = `data:text/html,${encodeURIComponent(
    '<title>Background Automation</title><label for="name">Name</label><input id="name"><button id="ready">Ready</button>',
  )}`
  const browser = await page.evaluate((fixtureUrl) => window.__cateE2E!.createBrowser(fixtureUrl, { x: 120, y: 120 }), url)

  await expect.poll(
    () => page.evaluate((panelId) => window.__cateE2E!.browserWebContentsId(panelId), browser.panelId),
    { timeout: 20_000 },
  ).not.toBeNull()
  const initialSnapshot = await page.evaluate(({ workspaceId, panelId }) => window.__cateE2E!.browserInvoke(
    workspaceId, 'readCommand', { panelId, command: ['snapshot', '-i'] },
  ), browser)
  if (!initialSnapshot.ok) throw new Error(`initial browser snapshot failed: ${initialSnapshot.error}`)
  expect(initialSnapshot).toMatchObject({
    ok: true,
    result: { snapshot: expect.stringContaining('button "Ready"') },
  })

  // Browser-only CI deliberately does not package the terminal runtime. A real
  // host control still proves target-bound guest input leaves renderer focus alone.
  const rendererFocusTarget = page.getByRole('button', { name: /Select tool/ })
  await rendererFocusTarget.focus()
  await expect(rendererFocusTarget).toBeFocused()

  const firstFill = await page.evaluate(({ workspaceId, panelId }) => window.__cateE2E!.browserInvoke(
    workspaceId, 'command', { panelId, command: ['fill', '#name', 'Renderer focus preserved'] },
  ), browser)
  if (!firstFill.ok) throw new Error(`browser fill failed: ${firstFill.error}`)
  await expect(rendererFocusTarget).toBeFocused()

  const otherWorkspace = await page.evaluate(() => window.__cateE2E!.addWorkspace('Other workspace'))
  await page.evaluate((workspaceId) => window.__cateE2E!.selectWorkspace(workspaceId), otherWorkspace)
  await expect(page.evaluate(({ workspaceId, panelId }) => window.__cateE2E!.browserInvoke(
    workspaceId, 'command', { panelId, command: ['fill', '#name', 'Filled from another workspace'] },
  ), browser)).resolves.toMatchObject({ ok: true })
  expect(await page.evaluate(() => window.__cateE2E!.activeCanvasPanelId())).not.toBeNull()

  await expect(page.evaluate(({ workspaceId, panelId }) => window.__cateE2E!.browserInvoke(
    workspaceId, 'readCommand', { panelId, command: ['get', 'value', '#name'] },
  ), browser)).resolves.toMatchObject({ ok: true, result: { value: 'Filled from another workspace' } })
})

test('browser is always a normal canvas card across zoom and pan', async () => {
  const browser = await page.evaluate(() => window.__cateE2E!.createBrowser(
    'data:text/html,<title>Stable canvas card</title><h1>Browser page</h1>', { x: 120, y: 120 },
  ))
  const nodeId = await expect.poll(() => page.evaluate(
    (panelId) => window.__cateE2E!.nodeForPanel(panelId), browser.panelId,
  )).not.toBeNull().then(() => page.evaluate((panelId) => window.__cateE2E!.nodeForPanel(panelId), browser.panelId))
  const node = page.locator(`[data-node-id="${nodeId}"]`)
  const surface = page.locator(`[data-browser-surface="${browser.panelId}"]`)
  await expect(node.locator(`[data-browser-surface-slot="${browser.panelId}"]`)).toBeVisible()
  await expect(surface).toHaveAttribute('data-browser-surface-visible', 'true')
  await expect(surface.locator('webview')).toHaveCount(1)
  const guestId = await expect.poll(
    () => page.evaluate((panelId) => window.__cateE2E!.browserWebContentsId(panelId), browser.panelId),
    { timeout: 20_000 },
  ).not.toBeNull().then(() => page.evaluate((panelId) => window.__cateE2E!.browserWebContentsId(panelId), browser.panelId))

  await page.evaluate(() => {
    window.__cateE2E!.setZoom(0.45)
    window.__cateE2E!.setViewport({ x: 260, y: 140 })
  })
  await expect(surface).toHaveAttribute('data-browser-surface-visible', 'true')
  expect(await page.evaluate((panelId) => window.__cateE2E!.browserWebContentsId(panelId), browser.panelId)).toBe(guestId)
})

test('user clicks and types directly in the live webview at non-default zoom', async () => {
  const url = `data:text/html,${encodeURIComponent(`
    <title>Interactive preview</title>
    <style>html,body{margin:0}#name{position:absolute;left:16px;top:16px;width:240px;height:40px}#save{position:absolute;left:16px;top:80px;width:160px;height:40px}</style>
    <input id="name"><button id="save" onclick="document.body.dataset.saved=document.querySelector('#name').value">Save</button>
  `)}`
  const browser = await page.evaluate((fixtureUrl) => window.__cateE2E!.createBrowser(
    fixtureUrl, { x: 120, y: 120 },
  ), url)
  const webview = page.locator(`[data-browser-surface="${browser.panelId}"] webview`).first()
  await expect(webview).toBeVisible({ timeout: 20_000 })
  const guestId = await expect.poll(
    () => page.evaluate((panelId) => window.__cateE2E!.browserWebContentsId(panelId), browser.panelId),
    { timeout: 20_000 },
  ).not.toBeNull().then(() => page.evaluate((panelId) => window.__cateE2E!.browserWebContentsId(panelId), browser.panelId))
  await page.evaluate(() => window.__cateE2E!.setZoom(0.65))

  const guestClick = (x: number, y: number) => app.evaluate(({ webContents }, input) => {
    const guest = webContents.fromId(input.id!)!
    guest.focus()
    guest.sendInputEvent({ type: 'mouseDown', x: input.x, y: input.y, button: 'left', clickCount: 1 })
    guest.sendInputEvent({ type: 'mouseUp', x: input.x, y: input.y, button: 'left', clickCount: 1 })
  }, { id: guestId, x, y })

  await guestClick(120, 36)
  await expect.poll(() => page.evaluate(({ workspaceId, panelId }) => window.__cateE2E!.browserInvoke(
    workspaceId, 'evaluate', { panelId, expression: 'document.activeElement?.id ?? ""' },
  ), browser), { timeout: 20_000 }).toMatchObject({ ok: true, result: { value: 'name' } })
  await app.evaluate(({ webContents }, input) => {
    const guest = webContents.fromId(input.id!)!
    for (const char of input.text) {
      guest.sendInputEvent({ type: 'keyDown', keyCode: char })
      guest.sendInputEvent({ type: 'char', keyCode: char })
      guest.sendInputEvent({ type: 'keyUp', keyCode: char })
    }
  }, { id: guestId, text: 'Typed inside Cate' })
  await expect.poll(() => page.evaluate(({ workspaceId, panelId }) => window.__cateE2E!.browserInvoke(
    workspaceId, 'readCommand', { panelId, command: ['get', 'value', '#name'] },
  ), browser), { timeout: 20_000 }).toMatchObject({ ok: true, result: { value: 'Typed inside Cate' } })

  await guestClick(80, 100)
  await expect.poll(() => page.evaluate(({ workspaceId, panelId }) => window.__cateE2E!.browserInvoke(
    workspaceId, 'readCommand', { panelId, command: ['get', 'attr', 'body', 'data-saved'] },
  ), browser), { timeout: 20_000 }).toMatchObject({ ok: true, result: { value: 'Typed inside Cate' } })
})
