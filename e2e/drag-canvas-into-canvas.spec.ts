import { test, expect } from '@playwright/test'
import {
  launchApp,
  closeApp,
  seedTerminal,
  resetViewport,
  titleBarCentre,
  getNodeRect,
  dragMouse,
} from './fixtures/electron-app'
import type { ElectronApplication, Page } from 'playwright'

let app: ElectronApplication
let page: Page

test.beforeEach(async () => {
  ;({ electronApp: app, mainWindow: page } = await launchApp())
  const window = await app.browserWindow(page)
  await window.evaluate((browserWindow) => browserWindow.setContentSize(1600, 900))
  // Collapse the left sidebar. It's a real flex item that PUSHES the canvas now
  // (#295), stealing ~260px of width — enough that a node seeded at canvas x=700
  // has its centre fall off the right window edge, so a drop aimed there misses
  // the mini-dock. Collapsing restores the wide canvas these geometry tests need.
  await page.evaluate(() => window.__cateE2E!.setSidebarHidden(true))
  await resetViewport(page)
})
test.afterEach(async () => closeApp(app))

test('canvas panel cannot be docked into a canvas-node mini-dock', async () => {
  const canvasId = await page.evaluate(() => window.__cateE2E!.activeCanvasPanelId()!)
  const target = await seedTerminal(page, { x: 1000, y: 200 })
  const source = await page.evaluate(() => window.__cateE2E!.createPanel('canvas'))
  await page.locator(`[data-tab-panel-id="${canvasId}"]`).click()

  const sourceTab = await page.locator(`[data-tab-panel-id="${source}"]`).boundingBox()
  const tRect = await getNodeRect(page, target)
  if (!sourceTab || !tRect) throw new Error('Canvas rejection fixture is not visible')
  // Aim at the target's tab-bar (would be 'tab' drop for a non-canvas source).
  const dropPoint = { x: tRect!.x + tRect!.width / 2, y: tRect!.y + 10 }
  await dragMouse(page, {
    x: sourceTab.x + sourceTab.width / 2,
    y: sourceTab.y + sourceTab.height / 2,
  }, dropPoint, { steps: 20, pauseAtEnd: 50 })

  await expect.poll(() => page.evaluate((id) => ({
    docked: window.__cateE2E!.dockDebug().zones.center.panelIds.includes(id),
    nested: window.__cateE2E!.canvasDebug().some((node) => node.panelIds.includes(id)),
  }), source)).toEqual({ docked: true, nested: false })
})

test('non-canvas tab is accepted into a canvas-node mini-dock', async () => {
  // Regression guard: the rejection above must be specific to canvas — a
  // terminal tab still docks normally.
  const target = await seedTerminal(page, { x: 1000, y: 200 })
  const source = await seedTerminal(page, { x: 300, y: 200 })
  const grab = await titleBarCentre(page, source)
  const tRect = await getNodeRect(page, target)
  const dropPoint = { x: tRect!.x + tRect!.width / 2, y: tRect!.y + 10 }
  await dragMouse(page, grab!, dropPoint, { steps: 20, pauseAtEnd: 50 })
  await page.waitForTimeout(150)
  // Terminal source was tabbed into target — its canvas-node is gone.
  const sourceStill = await page.$(`[data-node-id="${source}"]`)
  expect(sourceStill).toBeNull()
})
