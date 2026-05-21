import { test, expect } from '@playwright/test'
import { launchApp, closeApp } from './fixtures/electron-app'
import type { ElectronApplication, Page } from 'playwright'

let app: ElectronApplication
let page: Page

test.beforeEach(async () => {
  ;({ electronApp: app, mainWindow: page } = await launchApp())
})
test.afterEach(async () => closeApp(app))

test('app boots with E2E harness installed', async () => {
  const ready = await page.evaluate(() => window.__cateE2E?.ready === true)
  expect(ready).toBe(true)
})

test('a canvas is mounted', async () => {
  const panelId = await page.evaluate(() => window.__cateE2E!.activeCanvasPanelId())
  expect(panelId).toBeTruthy()
  const container = await page.$('[data-canvas-container]')
  expect(container).not.toBeNull()
})

test('seeding a terminal puts a node on the canvas', async () => {
  const nodeId = await page.evaluate(() =>
    window.__cateE2E!.createTerminal({ x: 200, y: 150 }),
  )
  expect(nodeId).toBeTruthy()
  await page.waitForSelector(`[data-node-id="${nodeId}"]`, { timeout: 5000 })
  const nodes = await page.evaluate(() => window.__cateE2E!.nodes())
  expect(nodes.find((n) => n.id === nodeId)).toMatchObject({
    origin: { x: 200, y: 150 },
  })
})
