import { act, createBrowser, inspectFixture } from './fixtures/browser-control'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import {
  closeApp,
  dragMouse,
  getNodeOrigin,
  getNodeRect,
  launchApp,
  seedOnCanvas,
  titleBarCentre,
  waitForGhost,
} from './fixtures/electron-app'

let app: ElectronApplication
let page: Page

test.beforeEach(async () => {
  ;({ electronApp: app, mainWindow: page } = await launchApp())
})

test.afterEach(async () => {
  await closeApp(app)
})

test('a scroll over an unfocused browser pans the canvas like any panel', async () => {
  const browser = await createBrowser(page, 'data:text/html,<h1>Page</h1>', { x: 100, y: 100 })
  const editor = await seedOnCanvas(page, 'editor', { x: 1000, y: 100 })
  const e = (await getNodeRect(page, editor.nodeId))!
  await page.mouse.click(e.x + e.width / 2, e.y + e.height / 2)
  const r = (await getNodeRect(page, browser.nodeId))!
  const centre = { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  const world = () => page.evaluate(() => document.querySelector<HTMLElement>('[data-canvas-world]')!.style.transform)
  const topTag = () => page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, centre)

  // Unfocused: the canvas, not the guest, takes the scroll.
  await expect.poll(topTag).toBe('DIV')
  const before = await world()
  await page.mouse.move(centre.x, centre.y)
  await page.mouse.wheel(40, 40)
  await expect.poll(world).not.toBe(before)

  // Focused: the page is live again.
  await page.mouse.click(centre.x, centre.y)
  await expect.poll(topTag).toBe('WEBVIEW')
})

test('moves a browser panel by its canvas title bar', async () => {
  const browser = await createBrowser(page,
    `data:text/html,${encodeURIComponent('<title>Draggable browser</title><h1>Browser page</h1><input id="name" aria-label="Name"><button id="save" onclick="document.body.dataset.saved=document.querySelector(\'#name\').value">Save</button>')}`,
    { x: 120, y: 120 },
  )
  const nodeId = browser.nodeId

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

  await expect(act(page, browser, 'setValue', "Name", { value: 'Moved workflow' })).resolves.toMatchObject({ ok: true })
  await expect(act(page, browser, 'click', "Save")).resolves.toMatchObject({ ok: true })
  await expect(inspectFixture(app!, page, browser, "document.querySelector(\"body\")?.getAttribute(\"data-saved\")")).resolves.toMatchObject({ ok: true, result: { value: 'Moved workflow' } })
})

test('does not focus the address bar while dragging a browser panel', async () => {
  // The start page (no url).
  const { panelId, nodeId } = await seedOnCanvas(page, 'browser', { x: 120, y: 120 })
  const browser = { panelId }
  // Measure the grab point once the node's tab is laid out.
  await expect(page.locator(`[data-node-id="${nodeId}"] [data-tab-panel-id]`).first()).toBeVisible()
  const grab = await titleBarCentre(page, nodeId!)
  expect(grab).not.toBeNull()

  await page.mouse.move(grab!.x, grab!.y)
  await page.mouse.down()
  await page.mouse.move(grab!.x + 20, grab!.y + 10, { steps: 4 })

  expect(await waitForGhost(page)).not.toBeNull()
  expect(await page.evaluate((panelId) => {
    const input = document.querySelector(`[data-browser-surface="${panelId}"] input`)
    return document.activeElement === input
  }, browser.panelId)).toBe(false)

  await page.mouse.move(grab!.x + 180, grab!.y + 120, { steps: 20 })
  await page.mouse.up()
})

test('closes active and inactive new tabs with a single click on their close buttons', async () => {
  const { panelId, nodeId } = await seedOnCanvas(page, 'browser', { x: 120, y: 120 })
  const browser = { panelId }
  const surface = page.locator(`[data-browser-surface="${browser.panelId}"]`)
  await expect(surface).toHaveAttribute('data-browser-surface-visible', 'true')
  // The first click focuses the node (its unfocused overlay takes it).
  await page.locator(`[data-node-id="${nodeId}"] [data-unfocused-overlay]`).click()
  const newTab = surface.getByRole('button', { name: 'New tab', exact: true })
  const closeTabs = surface.getByRole('button', { name: 'Close tab', exact: true })
  await newTab.click()
  await newTab.click()
  await expect(closeTabs).toHaveCount(3)

  // Close the active new tab, then the inactive one. Each click must remove
  // exactly one tab, and the remaining start page must keep its empty address.
  await expect(closeTabs.nth(2)).toBeEnabled()
  await closeTabs.nth(2).click()
  await expect(closeTabs).toHaveCount(2)
  await expect(surface.locator('input').first()).toHaveValue('')
  await closeTabs.first().hover()
  await expect(closeTabs.first()).toBeEnabled()
  await closeTabs.first().click()
  await expect(closeTabs).toHaveCount(1)
  await expect(surface.locator('input').first()).toHaveValue('')
})
