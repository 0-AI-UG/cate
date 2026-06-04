import { test, expect } from '@playwright/test'
import {
  launchApp,
  closeApp,
  seedTerminal,
  resetViewport,
  setZoom,
  titleBarCentre,
  getNodeRect,
  dragMouse,
} from './fixtures/electron-app'
import type { ElectronApplication, Page } from 'playwright'

let app: ElectronApplication
let page: Page

test.beforeEach(async () => {
  ;({ electronApp: app, mainWindow: page } = await launchApp())
  await resetViewport(page)
})
test.afterEach(async () => closeApp(app))

async function seedTwoTerminals(p: Page): Promise<{ a: string; b: string }> {
  // Seed past the 260px sidebar so both nodes are fully visible in the canvas
  // viewport — A on the left, B on the right with clear separation.
  const a = await seedTerminal(p, { x: 300, y: 100 })
  const b = await seedTerminal(p, { x: 1000, y: 100 })
  await p.evaluate(() => window.__cateE2E!.resetViewport())
  await p.waitForTimeout(200)
  return { a, b }
}

test('drop on target tab-bar tabs the source into target stack', async () => {
  const { a, b } = await seedTwoTerminals(page)
  const aGrab = await titleBarCentre(page, a)
  const bRect = await getNodeRect(page, b)
  // Aim at top 20px of target = tab-bar zone (resolveDropEdge returns 'center').
  const dropPoint = { x: bRect!.x + bRect!.width / 2, y: bRect!.y + 10 }
  await dragMouse(page, aGrab!, dropPoint, { steps: 25, pauseAtEnd: 50 })
  await page.waitForTimeout(150)
  // Source canvas-node a should be removed (it became a tab inside b's stack).
  const aStill = await page.$(`[data-node-id="${a}"]`)
  expect(aStill).toBeNull()
})

test('drop on target left edge splits horizontally', async () => {
  const { a, b } = await seedTwoTerminals(page)
  const aGrab = await titleBarCentre(page, a)
  const bRect = await getNodeRect(page, b)
  // Left ~12% strip — below the tab-bar height.
  const dropPoint = { x: bRect!.x + 12, y: bRect!.y + bRect!.height / 2 }
  await dragMouse(page, aGrab!, dropPoint, { steps: 25, pauseAtEnd: 50 })
  await page.waitForTimeout(150)
  const aStill = await page.$(`[data-node-id="${a}"]`)
  expect(aStill).toBeNull()
  // Verify b's mini-dock now has two leaf panels (split layout).
  const layoutLeaves = await page.evaluate((id) => {
    const el = document.querySelector(`[data-node-id="${id}"]`)
    return el?.querySelectorAll('.dock-tab-bar').length ?? 0
  }, b)
  expect(layoutLeaves).toBeGreaterThanOrEqual(2)
})

test('drop on target top edge splits vertically', async () => {
  const { a, b } = await seedTwoTerminals(page)
  const aGrab = await titleBarCentre(page, a)
  const bRect = await getNodeRect(page, b)
  // Top edge zone — but resolveDropEdge: y<38 returns 'center' (tab-bar).
  // To hit 'top' split we need y > 38 and inside the top ~12% strip — for a
  // typical 400px tall node, the top strip is ~48px. So aim at y=44ish (just
  // past the tab bar but still in the top split zone).
  const dropPoint = { x: bRect!.x + bRect!.width / 2, y: bRect!.y + 44 }
  await dragMouse(page, aGrab!, dropPoint, { steps: 25, pauseAtEnd: 50 })
  await page.waitForTimeout(150)
  const aStill = await page.$(`[data-node-id="${a}"]`)
  expect(aStill).toBeNull()
})

test('drop on target body centre (safe zone) does not commit', async () => {
  const { a, b } = await seedTwoTerminals(page)
  // The two 640px nodes can't both fit at zoom 1 in the e2e window, which would
  // push B's centre off-screen. Zoom out (and re-zero the offset) so B is fully
  // visible AND tall enough that its vertical centre clears the 38px tab-bar
  // drop band — otherwise the "body centre" drop lands off-screen / in the tab
  // band and wrongly docks.
  await setZoom(page, 0.6)
  await resetViewport(page)
  const aGrab = await titleBarCentre(page, a)
  const bRect = await getNodeRect(page, b)
  // Mid-body — outside the 12% edge strips AND below the tab-bar.
  const dropPoint = { x: bRect!.x + bRect!.width / 2, y: bRect!.y + bRect!.height / 2 }
  await dragMouse(page, aGrab!, dropPoint, { steps: 25, pauseAtEnd: 50 })
  await page.waitForTimeout(150)
  // Source node should STILL exist (it repositioned, not docked).
  const aStill = await page.$(`[data-node-id="${a}"]`)
  expect(aStill).not.toBeNull()
})
