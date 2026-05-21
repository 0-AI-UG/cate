import { test, expect } from '@playwright/test'
import {
  launchApp,
  closeApp,
  seedTerminal,
  resetViewport,
  titleBarCentre,
} from './fixtures/electron-app'
import type { ElectronApplication, Page } from 'playwright'

let app: ElectronApplication
let page: Page

test.beforeEach(async () => {
  ;({ electronApp: app, mainWindow: page } = await launchApp())
  await resetViewport(page)
})
test.afterEach(async () => closeApp(app))

test('drag past the window edge detaches into a new panel window', async () => {
  // Skip if main window is fullscreen — detach is intentionally refused there.
  const fullscreen = await page.evaluate(() =>
    window.electronAPI?.isMainWindowFullscreen?.() ?? false,
  )
  test.skip(fullscreen, 'detach is refused while the main window is fullscreen')

  const nodeId = await seedTerminal(page, { x: 300, y: 200 })
  await page.waitForSelector(`[data-node-id="${nodeId}"]`)
  const grab = await titleBarCentre(page, nodeId)
  expect(grab).not.toBeNull()

  const initialWindowCount = app.windows().length
  const innerSize = await page.evaluate(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
  }))

  // Drag PAST the right edge so the controller flips into cross-window mode,
  // then release outside the window to trigger detach.
  await page.mouse.move(grab!.x, grab!.y)
  await page.mouse.down()
  await page.mouse.move(grab!.x + 100, grab!.y, { steps: 10 })
  await page.mouse.move(innerSize.w + 50, grab!.y, { steps: 20 })
  // Hold briefly so the cross-window watchdog notices we're outside.
  await page.waitForTimeout(150)
  await page.mouse.up()

  // A new window should appear. Detach is async (IPC + window creation).
  await page.waitForTimeout(800)
  const finalCount = app.windows().length
  expect(finalCount).toBeGreaterThan(initialWindowCount)

  // The source canvas-node should be removed on successful detach.
  const sourceStill = await page.$(`[data-node-id="${nodeId}"]`)
  expect(sourceStill).toBeNull()
})

test('release without leaving the window does not detach', async () => {
  const initialCount = app.windows().length
  const nodeId = await seedTerminal(page, { x: 300, y: 200 })
  const grab = await titleBarCentre(page, nodeId)
  // Stay safely inside the window during the whole drag.
  await page.mouse.move(grab!.x, grab!.y)
  await page.mouse.down()
  await page.mouse.move(grab!.x + 200, grab!.y + 150, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  expect(app.windows().length).toBe(initialCount)
  // Node still exists (it just moved).
  const stillThere = await page.$(`[data-node-id="${nodeId}"]`)
  expect(stillThere).not.toBeNull()
})
