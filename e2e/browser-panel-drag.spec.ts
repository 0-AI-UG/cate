import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import {
  closeApp,
  dragMouse,
  getNodeOrigin,
  launchApp,
  titleBarCentre,
} from './fixtures/electron-app'

let app: ElectronApplication
let page: Page

test.beforeEach(async () => {
  ;({ electronApp: app, mainWindow: page } = await launchApp())
})

test.afterEach(async () => {
  await closeApp(app)
})

test('moves a browser panel by its canvas title bar', async () => {
  const browser = await page.evaluate(() => window.__cateE2E!.createBrowser(
    `data:text/html,${encodeURIComponent('<title>Draggable browser</title><h1>Browser page</h1><input id="name"><button id="save" onclick="document.body.dataset.saved=document.querySelector(\'#name\').value">Save</button>')}`,
    { x: 120, y: 120 },
  ))
  const nodeId = await expect.poll(() => page.evaluate(
    (panelId) => window.__cateE2E!.nodeForPanel(panelId), browser.panelId,
  )).not.toBeNull().then(() => page.evaluate(
    (panelId) => window.__cateE2E!.nodeForPanel(panelId), browser.panelId,
  ))

  const surface = page.locator(`[data-browser-surface="${browser.panelId}"]`)
  await expect(surface).toHaveAttribute('data-browser-surface-visible', 'true')

  const before = await getNodeOrigin(page, nodeId!)
  const grab = await titleBarCentre(page, nodeId!)
  expect(before).not.toBeNull()
  expect(grab).not.toBeNull()

  await dragMouse(page, grab!, { x: grab!.x + 180, y: grab!.y + 120 })

  await expect.poll(() => getNodeOrigin(page, nodeId!)).toEqual({
    x: before!.x + 180,
    y: before!.y + 120,
  })

  await expect(page.evaluate(({ workspaceId, panelId }) => window.__cateE2E!.browserInvoke(
    workspaceId, 'command', { panelId, command: ['fill', '#name', 'Moved workflow'] },
  ), browser)).resolves.toMatchObject({ ok: true })
  await expect(page.evaluate(({ workspaceId, panelId }) => window.__cateE2E!.browserInvoke(
    workspaceId, 'command', { panelId, command: ['click', '#save'] },
  ), browser)).resolves.toMatchObject({ ok: true })
  await expect(page.evaluate(({ workspaceId, panelId }) => window.__cateE2E!.browserInvoke(
    workspaceId, 'readCommand', { panelId, command: ['get', 'attr', 'body', 'data-saved'] },
  ), browser)).resolves.toMatchObject({ ok: true, result: { value: 'Moved workflow' } })
})

test('does not focus the address bar while dragging a browser panel', async () => {
  const browser = await page.evaluate(() => window.__cateE2E!.createBrowser(
    'cate://newtab',
    { x: 120, y: 120 },
  ))
  const nodeId = await expect.poll(() => page.evaluate(
    (panelId) => window.__cateE2E!.nodeForPanel(panelId), browser.panelId,
  )).not.toBeNull().then(() => page.evaluate(
    (panelId) => window.__cateE2E!.nodeForPanel(panelId), browser.panelId,
  ))
  const grab = await titleBarCentre(page, nodeId!)
  expect(grab).not.toBeNull()

  await page.mouse.move(grab!.x, grab!.y)
  await page.mouse.down()
  await page.mouse.move(grab!.x + 20, grab!.y + 10)

  await expect.poll(() => page.evaluate(() => window.__cateE2E!.dragSnapshot().isDragging)).toBe(true)
  expect(await page.evaluate((panelId) => {
    const input = document.querySelector(`[data-browser-surface="${panelId}"] input`)
    return document.activeElement === input
  }, browser.panelId)).toBe(false)

  await page.mouse.move(grab!.x + 180, grab!.y + 120, { steps: 20 })
  await page.mouse.up()
})
